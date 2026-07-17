// Reply / bounce / complaint detection via the Resend webhook (mock: fixture
// events posted straight into handleInboundEvent). Effects:
//   reply     → lead status 'replied' + cancel pending follow-up sequence
//   bounce    → message marked bounced + permanent suppression + cancel sequence
//   complaint → permanent suppression + cancel sequence
// All effects are audit-logged. An IMAP poller can feed the same handler if a
// webhook can't be exposed — the event shape is provider-agnostic.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { addSuppression, logEvent, setLeadStatus, type DB, type Lead } from '@storefront/db';
import { cancelSequencesForLead } from './sequence.js';

export interface InboundEmailEvent {
  kind: 'reply' | 'bounce' | 'complaint' | 'open';
  /** The prospect's address (sender of a reply; recipient of a bounce/open). */
  email: string;
  subject?: string;
}

export interface InboundResult {
  matched: boolean;
  leadId?: number;
  action?: string;
}

async function leadByEmail(db: DB, email: string): Promise<Lead | undefined> {
  return db.get<Lead>(`SELECT * FROM leads WHERE lower(contact_email) = ? ORDER BY id ASC LIMIT 1`, [
    email.toLowerCase().trim(),
  ]);
}

/** Apply one inbound event to the pipeline. Idempotent. */
export async function handleInboundEvent(db: DB, evt: InboundEmailEvent): Promise<InboundResult> {
  const lead = await leadByEmail(db, evt.email);
  if (!lead) {
    await logEvent(db, 'inbound.unmatched', null, { kind: evt.kind, email: evt.email });
    return { matched: false };
  }

  switch (evt.kind) {
    case 'reply': {
      if (lead.status !== 'replied') await setLeadStatus(db, lead.id, 'replied');
      await cancelSequencesForLead(db, lead.id, 'lead replied');
      await logEvent(db, 'reply.received', lead.id, { email: evt.email, subject: evt.subject ?? null });
      return { matched: true, leadId: lead.id, action: 'replied' };
    }
    case 'bounce': {
      await db.run(
        `UPDATE messages SET status = 'bounced'
         WHERE lead_id = ? AND channel = 'email' AND status = 'sent'`,
        [lead.id],
      );
      await addSuppression(db, evt.email, 'hard bounce');
      await cancelSequencesForLead(db, lead.id, 'address bounced');
      await logEvent(db, 'bounce.recorded', lead.id, { email: evt.email });
      return { matched: true, leadId: lead.id, action: 'bounced+suppressed' };
    }
    case 'complaint': {
      await addSuppression(db, evt.email, 'spam complaint');
      await cancelSequencesForLead(db, lead.id, 'recipient complained');
      await logEvent(db, 'complaint.recorded', lead.id, { email: evt.email });
      return { matched: true, leadId: lead.id, action: 'suppressed' };
    }
    case 'open': {
      await logEvent(db, 'open.recorded', lead.id, { email: evt.email });
      return { matched: true, leadId: lead.id, action: 'open-recorded' };
    }
  }
}

// ── Resend wire format ───────────────────────────────────────────────────────

interface ResendWebhookPayload {
  type?: string;
  data?: {
    from?: string;
    to?: string | string[];
    subject?: string;
  };
}

const addr = (v: string | string[] | undefined): string | null => {
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/); // "Name <a@b.c>" → a@b.c
  return (m?.[1] ?? raw).trim();
};

/** Map a Resend webhook payload onto a provider-agnostic inbound event. */
export function parseResendWebhook(payload: ResendWebhookPayload): InboundEmailEvent | null {
  const type = payload.type ?? '';
  if (type === 'email.received' || type === 'inbound.email.received') {
    const email = addr(payload.data?.from);
    return email ? { kind: 'reply', email, subject: payload.data?.subject } : null;
  }
  if (type === 'email.bounced') {
    const email = addr(payload.data?.to);
    return email ? { kind: 'bounce', email } : null;
  }
  if (type === 'email.complained') {
    const email = addr(payload.data?.to);
    return email ? { kind: 'complaint', email } : null;
  }
  if (type === 'email.opened') {
    const email = addr(payload.data?.to);
    return email ? { kind: 'open', email } : null;
  }
  return null; // delivery events etc. — not actionable here
}

/**
 * Verify a Resend (svix-style) webhook signature. Returns true when the
 * signature matches. When no secret is configured the caller decides whether
 * to accept (dev) or reject (prod).
 */
export function verifyResendSignature(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signed = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signed).digest('base64');
  // Header format: "v1,<base64sig> v1,<base64sig> ..."
  return headers.signature.split(' ').some((part) => {
    const sig = part.split(',')[1] ?? '';
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
