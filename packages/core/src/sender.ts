import {
  getLead,
  getMessage,
  updateMessageStatus,
  setLeadStatus,
  addSuppression,
  logEvent,
  type DB,
  type Message,
} from '@storefront/db';
import type { EmailProvider } from '@storefront/email';
import type { StorefrontConfig } from './config.js';
import { checkSendGate, type SendGate } from './compliance.js';

export interface SendDeps {
  db: DB;
  email: EmailProvider;
  config: StorefrontConfig;
}

/** Gate B→C transition: a human marks a draft approved. */
export function approveMessage(db: DB, messageId: number, approvedBy: string): Message {
  const msg = getMessage(db, messageId);
  if (!msg) throw new Error(`Message ${messageId} not found`);
  if (msg.status !== 'draft' && msg.status !== 'approved') {
    throw new Error(`Message ${messageId} is ${msg.status}, cannot approve`);
  }
  const updated = updateMessageStatus(db, messageId, 'approved', { approved_by: approvedBy });
  logEvent(db, 'message.approved', msg.lead_id, { message_id: messageId, approved_by: approvedBy });
  return updated;
}

export interface SendOutcome {
  sent: boolean;
  gate: SendGate;
  providerId?: string;
  error?: string;
  dryRun: boolean;
}

/**
 * Gate C — the ONLY path that puts mail on the wire. Enforces the full send
 * gate (suppression, daily cap, approval, CAN-SPAM), then sends via the email
 * provider. Pass dryRun to run every check and log intent WITHOUT sending.
 */
export async function sendApprovedMessage(
  deps: SendDeps,
  messageId: number,
  opts: { dryRun?: boolean } = {},
): Promise<SendOutcome> {
  const { db, email, config } = deps;
  const dryRun = opts.dryRun ?? false;

  const message = getMessage(db, messageId);
  if (!message) throw new Error(`Message ${messageId} not found`);
  if (message.channel !== 'email') {
    // Call scripts (and any future non-email channel) must never hit the
    // email wire, approved or not.
    throw new Error(`Message ${messageId} is channel '${message.channel}', not sendable as email`);
  }
  const lead = getLead(db, message.lead_id);
  if (!lead) throw new Error(`Lead ${message.lead_id} not found`);

  const gate = checkSendGate(db, config, lead, message);
  if (!gate.ok) {
    logEvent(db, 'send.blocked', lead.id, { message_id: messageId, reasons: gate.reasons });
    return { sent: false, gate, dryRun };
  }

  if (dryRun) {
    logEvent(db, 'send.dry_run', lead.id, {
      message_id: messageId,
      to: lead.contact_email,
      sentToday: gate.sentToday,
      cap: gate.cap,
    });
    return { sent: false, gate, dryRun: true };
  }

  const result = await email.send({
    to: lead.contact_email!,
    from: `${config.senderName} <hello@${config.fromDomain}>`,
    replyTo: config.replyTo,
    subject: message.subject ?? '',
    text: message.body ?? '',
    idempotencyKey: `storefront-msg-${messageId}`,
    headers: {
      'List-Unsubscribe': `<${unsubFromBody(message.body)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });

  if (!result.ok) {
    logEvent(db, 'send.failed', lead.id, { message_id: messageId, error: result.error });
    return { sent: false, gate, error: result.error, dryRun: false };
  }

  updateMessageStatus(db, messageId, 'sent', { sent_at: new Date().toISOString() });
  setLeadStatus(db, lead.id, 'contacted');
  logEvent(db, 'send.sent', lead.id, {
    message_id: messageId,
    provider: result.provider,
    provider_id: result.id,
    to: lead.contact_email,
  });
  return { sent: true, gate, providerId: result.id, dryRun: false };
}

/** Record an unsubscribe: permanent suppression + audit. */
export function recordUnsubscribe(db: DB, email: string, leadId?: number): void {
  addSuppression(db, email, 'recipient unsubscribed');
  logEvent(db, 'unsubscribe', leadId ?? null, { email });
}

function unsubFromBody(body: string | null): string {
  const m = body?.match(/https?:\/\/\S*unsubscribe\?email=\S+/);
  return m?.[0] ?? '';
}
