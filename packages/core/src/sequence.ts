// Follow-up sequencing (Phase 2). Automation DRAFTS a sequence; a human must
// approve it before anything is eligible to send; the runner enforces spacing
// and auto-cancel, and every individual send still goes through
// sendApprovedMessage → checkSendGate (suppression, cap, CAN-SPAM, approval).

import {
  getLead,
  getMessageByLead,
  getSequence,
  getSequenceByLead,
  insertMessage,
  insertSequence,
  isSuppressed,
  listSequenceMessages,
  listSequences,
  logEvent,
  updateMessageStatus,
  updateSequenceStatus,
  type DB,
  type Lead,
  type Message,
  type Sequence,
} from '@storefront/db';
import type { StorefrontConfig } from './config.js';
import { complianceFooter } from './compliance.js';
import { sendApprovedMessage, type SendDeps, type SendOutcome } from './sender.js';

/** Hard ceiling from the spec — a sequence may NEVER exceed 2 follow-ups. */
export const MAX_FOLLOWUPS = 2;
/** Hard floor from the spec — follow-ups may NEVER be closer than 4 days. */
export const MIN_SPACING_DAYS = 4;

const FOLLOWUP_COPY: ((name: string, demoUrl: string) => { subject: string; body: string })[] = [
  (name, demoUrl) => ({
    subject: `Re: a fresh website for ${name}`,
    body:
      `Hi again,\n\nJust floating this back up in case it got buried — the free website ` +
      `preview I built for ${name} is still live here:\n\n${demoUrl}\n\n` +
      `If it's not a fit, no need to reply; I won't keep nudging. If you'd like any part ` +
      `of it changed, I'm happy to tweak it.\n\nBest,`,
  }),
  (name, demoUrl) => ({
    subject: `Last note — ${name} website preview comes down soon`,
    body:
      `Hi,\n\nQuick heads-up: the demo site I built for ${name} comes down soon ` +
      `(it's a temporary preview):\n\n${demoUrl}\n\n` +
      `This is my last email about it — if the timing's wrong, no worries at all, and ` +
      `you won't hear from me again about this.\n\nThanks for your time,`,
  }),
];

/**
 * Draft a follow-up sequence for a CONTACTED lead. Creates the sequence row +
 * follow-up drafts (status `draft`). Nothing here is sendable until a human
 * approves the sequence.
 */
export async function draftFollowupSequence(
  db: DB,
  config: StorefrontConfig,
  lead: Lead,
): Promise<{ sequence: Sequence; messages: Message[] }> {
  if (lead.status !== 'contacted') {
    throw new Error(`Lead ${lead.id} is ${lead.status}; follow-ups only apply to contacted leads`);
  }
  if (!lead.contact_email) throw new Error(`Lead ${lead.id} has no contact email`);
  const sentBefore = (await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages
     WHERE lead_id = ? AND channel = 'email' AND status = 'sent'`,
    [lead.id],
  ))!;
  if (sentBefore.n === 0) {
    throw new Error(`Lead ${lead.id} has no sent initial outreach — nothing to follow up on`);
  }
  const existing = await getSequenceByLead(db, lead.id);
  if (existing && existing.status !== 'canceled') {
    throw new Error(`Lead ${lead.id} already has a ${existing.status} sequence`);
  }

  const spacing = Math.max(config.followupDays, MIN_SPACING_DAYS);
  const sequence = await insertSequence(db, {
    lead_id: lead.id,
    max_followups: MAX_FOLLOWUPS,
    spacing_days: spacing,
  });

  const messages: Message[] = [];
  for (let step = 1; step <= MAX_FOLLOWUPS; step++) {
    const copy = FOLLOWUP_COPY[step - 1]!(lead.name, lead.demo_url ?? '');
    const body =
      `${copy.body}\n${config.senderName}\n${config.senderBusiness}` +
      complianceFooter(config, lead.contact_email);
    messages.push(
      await insertMessage(db, {
        lead_id: lead.id,
        channel: 'email',
        subject: copy.subject,
        body,
        status: 'draft',
        sequence_id: sequence.id,
        followup_step: step,
      }),
    );
  }
  return { sequence, messages };
}

/**
 * Gate: a HUMAN approves the whole sequence. Marks the sequence approved and
 * each follow-up message approved (so checkSendGate's approval requirement is
 * satisfied by a real human action, per-message).
 */
export async function approveSequence(
  db: DB,
  sequenceId: number,
  approvedBy: string,
): Promise<Sequence> {
  const seq = await getSequence(db, sequenceId);
  if (!seq) throw new Error(`Sequence ${sequenceId} not found`);
  if (seq.status !== 'draft') throw new Error(`Sequence ${sequenceId} is ${seq.status}, cannot approve`);
  for (const msg of await listSequenceMessages(db, sequenceId)) {
    if (msg.status === 'draft') {
      await updateMessageStatus(db, msg.id, 'approved', { approved_by: approvedBy });
    }
  }
  const updated = await updateSequenceStatus(db, sequenceId, 'approved', { approved_by: approvedBy });
  await logEvent(db, 'sequence.approved', seq.lead_id, { sequence_id: sequenceId, approved_by: approvedBy });
  return updated;
}

/** Cancel a sequence and void its unsent follow-ups. Idempotent. */
export async function cancelSequence(db: DB, sequenceId: number, reason: string): Promise<void> {
  const seq = await getSequence(db, sequenceId);
  if (!seq || seq.status === 'canceled' || seq.status === 'completed') return;
  for (const msg of await listSequenceMessages(db, sequenceId)) {
    if (msg.status === 'draft' || msg.status === 'approved') {
      await updateMessageStatus(db, msg.id, 'canceled');
    }
  }
  await updateSequenceStatus(db, sequenceId, 'canceled', { cancel_reason: reason });
  await logEvent(db, 'sequence.canceled', seq.lead_id, { sequence_id: sequenceId, reason });
}

/** Cancel any live sequence for a lead (reply/unsubscribe hooks call this). */
export async function cancelSequencesForLead(db: DB, leadId: number, reason: string): Promise<void> {
  for (const seq of await listSequences(db)) {
    if (seq.lead_id === leadId && (seq.status === 'draft' || seq.status === 'approved')) {
      await cancelSequence(db, seq.id, reason);
    }
  }
}

/** Cancel live sequences for every lead whose contact email matches. */
export async function cancelSequencesForEmail(db: DB, email: string, reason: string): Promise<void> {
  const rows = await db.all<{ id: number }>(`SELECT id FROM leads WHERE lower(contact_email) = ?`, [
    email.toLowerCase().trim(),
  ]);
  for (const r of rows) await cancelSequencesForLead(db, r.id, reason);
}

export interface SequenceRunResult {
  examined: number;
  sent: number;
  skippedNotDue: number;
  canceled: number;
  completed: number;
  outcomes: { sequenceId: number; step: number; outcome: SendOutcome }[];
}

const DAY_MS = 86_400_000;

/**
 * The sequence runner (scheduled job). For each APPROVED sequence:
 *  • auto-cancel if the lead replied / closed or the recipient unsubscribed
 *  • send the next follow-up only if the previous send is ≥ spacing_days old
 *  • every send goes through sendApprovedMessage → checkSendGate
 *  • mark completed when all follow-ups are sent
 */
export async function runSequences(
  deps: SendDeps,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<SequenceRunResult> {
  const { db } = deps;
  const now = opts.now ?? new Date();
  const result: SequenceRunResult = {
    examined: 0,
    sent: 0,
    skippedNotDue: 0,
    canceled: 0,
    completed: 0,
    outcomes: [],
  };

  for (const seq of await listSequences(db, 'approved')) {
    result.examined++;
    const lead = await getLead(db, seq.lead_id);
    if (!lead) continue;

    // Auto-cancel conditions.
    if (lead.status === 'replied' || lead.status === 'won' || lead.status === 'lost') {
      await cancelSequence(db, seq.id, `lead status is ${lead.status}`);
      result.canceled++;
      continue;
    }
    if (!lead.contact_email || (await isSuppressed(db, lead.contact_email))) {
      await cancelSequence(db, seq.id, 'recipient unsubscribed/suppressed');
      result.canceled++;
      continue;
    }

    const steps = await listSequenceMessages(db, seq.id);
    const unsent = steps.filter((m) => m.status === 'approved');
    if (unsent.length === 0) {
      await updateSequenceStatus(db, seq.id, 'completed');
      await logEvent(db, 'sequence.completed', seq.lead_id, { sequence_id: seq.id });
      result.completed++;
      continue;
    }

    // Hard ceiling, independent of what's in the DB.
    const sentCount = steps.filter((m) => m.status === 'sent').length;
    if (sentCount >= Math.min(seq.max_followups, MAX_FOLLOWUPS)) {
      await updateSequenceStatus(db, seq.id, 'completed');
      await logEvent(db, 'sequence.completed', seq.lead_id, { sequence_id: seq.id, note: 'cap reached' });
      result.completed++;
      continue;
    }

    const next = unsent[0]!;
    // Spacing: measured from the most recent SENT message to this lead
    // (initial outreach for step 1, previous follow-up for step 2).
    const prevSentAt = (await db.get<{ t: string | null }>(
      `SELECT MAX(sent_at) AS t FROM messages
       WHERE lead_id = ? AND status = 'sent' AND channel = 'email'`,
      [seq.lead_id],
    ))!;
    if (!prevSentAt.t) {
      await cancelSequence(db, seq.id, 'no prior sent message found');
      result.canceled++;
      continue;
    }
    const spacing = Math.max(seq.spacing_days, MIN_SPACING_DAYS);
    const eligibleAt = Date.parse(prevSentAt.t) + spacing * DAY_MS;
    if (now.getTime() < eligibleAt) {
      result.skippedNotDue++;
      continue;
    }

    const outcome = await sendApprovedMessage(deps, next.id, { dryRun: opts.dryRun });
    result.outcomes.push({ sequenceId: seq.id, step: next.followup_step ?? 0, outcome });
    if (outcome.sent) {
      result.sent++;
      await logEvent(db, 'sequence.step_sent', seq.lead_id, {
        sequence_id: seq.id,
        step: next.followup_step,
        message_id: next.id,
      });
      const remaining = (await listSequenceMessages(db, seq.id)).filter((m) => m.status === 'approved');
      if (remaining.length === 0) {
        await updateSequenceStatus(db, seq.id, 'completed');
        await logEvent(db, 'sequence.completed', seq.lead_id, { sequence_id: seq.id });
        result.completed++;
      }
    } else if (!outcome.gate.ok && outcome.gate.reasons.some((r) => r.includes('suppression'))) {
      await cancelSequence(db, seq.id, 'blocked by suppression at send time');
      result.canceled++;
    }
    // Cap-blocked or dry-run: leave the sequence approved; the next run retries.
  }

  return result;
}
