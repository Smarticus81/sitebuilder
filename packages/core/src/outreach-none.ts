// Phase 3 — the `none` segment (no real website) is phone-first: the operator
// gets a call script, and can offer to "text the demo" via SMS.
//
// SMS compliance (TCPA), in code — mirrors the email gate's shape:
//   • checkSmsGate() is the ONLY path to the SMS wire
//   • approval REQUIRES a human-documented consent basis (documented opt-in or
//     an explicitly confirmed prior business relationship) — never auto-filled
//   • permanent phone suppression (STOP replies), checked on every send
//   • daily SMS cap + quiet hours (no texts outside 9am–8pm local)
//   • every body must carry opt-out language ("Reply STOP…")

import {
  addPhoneSuppression,
  countSmsSentToday,
  getLead,
  getSms,
  insertMessage,
  insertSms,
  isPhoneSuppressed,
  logEvent,
  updateSmsStatus,
  type DB,
  type Lead,
  type Message,
  type SmsMessage,
} from '@storefront/db';
import type { SmsProvider } from '@storefront/sms';
import type { StorefrontConfig } from './config.js';

// ── Call scripts ─────────────────────────────────────────────────────────────

/**
 * Draft a call script for a phone-first lead. Channel `call_script` is for the
 * operator's eyes only — the send path refuses to email it.
 */
export async function draftCallScript(
  db: DB,
  config: StorefrontConfig,
  lead: Lead,
): Promise<Message> {
  if (!lead.phone) throw new Error(`Lead ${lead.id} (${lead.name}) has no phone number`);
  const demoLine = lead.demo_url
    ? `I actually put together a free preview of what a modern site for ${lead.name} could look like — I can text you the link right now if you'd like.`
    : `I put together free website previews for local businesses like yours — happy to build one for ${lead.name}, no strings attached.`;

  const body = [
    `CALL SCRIPT — ${lead.name} (${lead.phone})`,
    ``,
    `Opener:`,
    `  "Hi, this is ${config.senderName} with ${config.senderBusiness} — we're a small local`,
    `  web studio. Do you have a quick minute? I'm not selling anything today."`,
    ``,
    `Why I'm calling:`,
    `  "I was looking up ${lead.category?.replace(/_/g, ' ') ?? 'businesses'} in the area and noticed ${lead.name}`,
    `  ${lead.website_url ? 'has a website that may be hurting you on mobile' : "doesn't have a website yet"} — most folks find businesses on their phones now."`,
    ``,
    `The offer:`,
    `  "${demoLine}"`,
    ``,
    `If interested:  confirm it's OK to text this number, note the OK in the CRM`,
    `                (that's the documented consent for the SMS), then send the demo text.`,
    `If not:         "No problem at all — thanks for your time!" Mark the lead lost.`,
    ``,
    `Rules: never leave robo-voicemails; call only 9am–8pm local; one polite follow-up max.`,
  ].join('\n');

  const message = await insertMessage(db, {
    lead_id: lead.id,
    channel: 'call_script',
    subject: `Call script — ${lead.name}`,
    body,
    status: 'draft',
  });
  await logEvent(db, 'callscript.drafted', lead.id, { message_id: message.id });
  return message;
}

// ── SMS drafting ─────────────────────────────────────────────────────────────

export const SMS_OPT_OUT_SUFFIX = 'Reply STOP to opt out.';

/** Draft the "text the demo" SMS. Requires a built demo and a phone number. */
export async function draftDemoSms(
  db: DB,
  config: StorefrontConfig,
  lead: Lead,
): Promise<SmsMessage> {
  if (!lead.phone) throw new Error(`Lead ${lead.id} has no phone number`);
  if (!lead.demo_url) throw new Error(`Lead ${lead.id} has no demo — build it first (Gate A)`);
  const body =
    `Hi, it's ${config.senderName} from ${config.senderBusiness} — as discussed, here's the ` +
    `free website preview for ${lead.name}: ${lead.demo_url} ` +
    `No obligation. ${SMS_OPT_OUT_SUFFIX}`;
  return await insertSms(db, { lead_id: lead.id, to_phone: lead.phone, body });
}

// ── The SMS gate ─────────────────────────────────────────────────────────────

export interface SmsGate {
  ok: boolean;
  reasons: string[];
  sentToday: number;
  cap: number;
}

export interface SmsPolicy {
  dailyCap: number;
  /** Local-time send window (hours, inclusive start / exclusive end). */
  quietHoursStart: number; // e.g. 20 → no sends at/after 8pm
  quietHoursEnd: number; // e.g. 9  → no sends before 9am
  /** Offset from UTC for the prospects' local time, in hours (e.g. -5 for CT). */
  tzOffsetHours: number;
}

export function smsPolicy(env: NodeJS.ProcessEnv = process.env): SmsPolicy {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
  };
  return {
    dailyCap: num(env.SMS_DAILY_CAP, 10),
    quietHoursStart: num(env.SMS_QUIET_START_HOUR, 20),
    quietHoursEnd: num(env.SMS_QUIET_END_HOUR, 9),
    tzOffsetHours: num(env.SMS_TZ_OFFSET_HOURS, -5),
  };
}

/**
 * Human gate: approving an SMS REQUIRES a documented TCPA basis, typed by the
 * operator (e.g. "spoke on phone 2026-07-16, owner said OK to text").
 */
export async function approveSms(
  db: DB,
  smsId: number,
  approvedBy: string,
  tcpaBasis: string,
): Promise<SmsMessage> {
  const sms = await getSms(db, smsId);
  if (!sms) throw new Error(`SMS ${smsId} not found`);
  if (sms.status !== 'draft') throw new Error(`SMS ${smsId} is ${sms.status}, cannot approve`);
  const basis = tcpaBasis?.trim();
  if (!basis || basis.length < 10) {
    throw new Error(
      'TCPA basis required: describe the documented opt-in or the confirmed prior ' +
        'business relationship (min 10 chars). SMS cannot be approved without it.',
    );
  }
  const updated = await updateSmsStatus(db, smsId, 'approved', {
    approved_by: approvedBy,
    tcpa_basis: basis,
  });
  await logEvent(db, 'sms.approved', sms.lead_id, { sms_id: smsId, approved_by: approvedBy, tcpa_basis: basis });
  return updated;
}

/**
 * The hard SMS gate. ALL must pass before a text leaves:
 *  • human-approved with a recorded TCPA basis
 *  • phone not on the permanent opt-out list
 *  • body carries STOP opt-out language
 *  • daily SMS cap not exceeded
 *  • inside the allowed local-time window
 */
export async function checkSmsGate(
  db: DB,
  policy: SmsPolicy,
  sms: SmsMessage,
  now: Date = new Date(),
): Promise<SmsGate> {
  const reasons: string[] = [];
  const sentToday = await countSmsSentToday(db);

  if (sms.status !== 'approved') reasons.push(`SMS is not approved (status: ${sms.status})`);
  if (!sms.tcpa_basis?.trim()) reasons.push('No documented TCPA consent basis recorded');
  if (await isPhoneSuppressed(db, sms.to_phone)) reasons.push('Phone number opted out (STOP)');
  if (!sms.body.includes('STOP')) reasons.push('Body is missing STOP opt-out language');
  if (sentToday >= policy.dailyCap) reasons.push(`Daily SMS cap reached (${sentToday}/${policy.dailyCap})`);

  const localHour =
    (((now.getUTCHours() + policy.tzOffsetHours) % 24) + 24) % 24;
  if (localHour >= policy.quietHoursStart || localHour < policy.quietHoursEnd) {
    reasons.push(
      `Outside allowed send window (local hour ${localHour}; allowed ${policy.quietHoursEnd}:00–${policy.quietHoursStart}:00)`,
    );
  }

  return { ok: reasons.length === 0, reasons, sentToday, cap: policy.dailyCap };
}

export interface SmsSendOutcome {
  sent: boolean;
  gate: SmsGate;
  providerId?: string;
  error?: string;
  dryRun: boolean;
}

/** The ONLY path that puts an SMS on the wire. */
export async function sendApprovedSms(
  deps: { db: DB; sms: SmsProvider; config: StorefrontConfig },
  smsId: number,
  opts: { dryRun?: boolean; now?: Date; policy?: SmsPolicy } = {},
): Promise<SmsSendOutcome> {
  const { db, sms: provider } = deps;
  const dryRun = opts.dryRun ?? false;
  const policy = opts.policy ?? smsPolicy();

  const sms = await getSms(db, smsId);
  if (!sms) throw new Error(`SMS ${smsId} not found`);
  const lead = await getLead(db, sms.lead_id);

  const gate = await checkSmsGate(db, policy, sms, opts.now);
  if (!gate.ok) {
    await logEvent(db, 'sms.blocked', sms.lead_id, { sms_id: smsId, reasons: gate.reasons });
    return { sent: false, gate, dryRun };
  }
  if (dryRun) {
    await logEvent(db, 'sms.dry_run', sms.lead_id, { sms_id: smsId, to: sms.to_phone });
    return { sent: false, gate, dryRun: true };
  }

  const result = await provider.send({ to: sms.to_phone, from: '', body: sms.body });
  if (!result.ok) {
    await logEvent(db, 'sms.failed', sms.lead_id, { sms_id: smsId, error: result.error });
    return { sent: false, gate, error: result.error, dryRun: false };
  }

  await updateSmsStatus(db, smsId, 'sent', {
    sent_at: new Date().toISOString(),
    provider_id: result.id,
  });
  await logEvent(db, 'sms.sent', sms.lead_id, {
    sms_id: smsId,
    provider: result.provider,
    provider_id: result.id,
    to: sms.to_phone,
    tcpa_basis: sms.tcpa_basis,
  });
  if (lead && (lead.status === 'qualified' || lead.status === 'demo_built' || lead.status === 'ready')) {
    // SMS contact advances the pipeline the same way an email send does.
    const { setLeadStatus } = await import('@storefront/db');
    await setLeadStatus(db, lead.id, 'contacted');
  }
  return { sent: true, gate, providerId: result.id, dryRun: false };
}

/** Inbound STOP handling (Twilio webhook or manual entry). Permanent. */
export async function recordSmsOptOut(db: DB, phone: string, leadId?: number): Promise<void> {
  await addPhoneSuppression(db, phone, 'recipient texted STOP');
  await logEvent(db, 'sms.opt_out', leadId ?? null, { phone });
}
