import { createHmac } from 'node:crypto';
import { countSentToday, isSuppressed, type DB, type Lead, type Message } from '@storefront/db';
import type { StorefrontConfig } from './config.js';

const UNSUB_SECRET = process.env.UNSUBSCRIBE_SECRET ?? 'storefront-dev-secret';

export function unsubscribeToken(email: string): string {
  return createHmac('sha256', UNSUB_SECRET)
    .update(email.toLowerCase().trim())
    .digest('hex')
    .slice(0, 16);
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  return unsubscribeToken(email) === token;
}

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKER_PUBLIC_URL ?? `http://localhost:${env.WORKER_PORT ?? '8787'}`;
}

export function unsubscribeUrl(email: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = publicBaseUrl(env);
  return `${base}/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
}

/**
 * The CAN-SPAM compliance block appended to EVERY outreach email:
 * physical mailing address + working one-click unsubscribe.
 */
export function complianceFooter(config: StorefrontConfig, email: string): string {
  return (
    `\n\n—\n` +
    `${config.senderName}, ${config.senderBusiness}\n` +
    `${config.mailingAddress}\n` +
    `You received this because we build website previews for local businesses. ` +
    `Unsubscribe (one click, permanent): ${unsubscribeUrl(email)}`
  );
}

export interface ComplianceCheck {
  ok: boolean;
  problems: string[];
}

/** Static CAN-SPAM validation of a composed message. */
export function validateCanSpam(
  config: StorefrontConfig,
  email: string,
  subject: string,
  body: string,
): ComplianceCheck {
  const problems: string[] = [];
  if (!subject.trim()) problems.push('Missing subject line');
  if (/free money|guarantee|act now|!!!|\$\$\$/i.test(subject))
    problems.push('Subject looks deceptive/spammy');
  if (!config.mailingAddress.trim())
    problems.push('No physical mailing address configured (MAILING_ADDRESS)');
  if (!body.includes(config.mailingAddress))
    problems.push('Body is missing the physical mailing address');
  if (!body.includes('Unsubscribe') || !body.includes('unsubscribe?email='))
    problems.push('Body is missing a working unsubscribe link');
  if (!config.replyTo.trim()) problems.push('No reply-to address configured');
  return { ok: problems.length === 0, problems };
}

export interface SendGate {
  ok: boolean;
  reasons: string[];
  sentToday: number;
  cap: number;
}

/**
 * The hard send gate (Gate C). ALL must pass before a message leaves:
 *  • lead has a contact email
 *  • email is not on the permanent suppression list
 *  • message is human-approved
 *  • daily cap not exceeded
 *  • message body passes CAN-SPAM validation
 *
 * NOTE: async is purely mechanical (the DB driver is async for Postgres
 * support) — the checks, their order, and their semantics are unchanged.
 */
export async function checkSendGate(
  db: DB,
  config: StorefrontConfig,
  lead: Lead,
  message: Message,
): Promise<SendGate> {
  const reasons: string[] = [];
  const cap = config.dailySendCap;
  const sentToday = await countSentToday(db);

  if (!lead.contact_email) reasons.push('Lead has no contact email');
  if (lead.contact_email && (await isSuppressed(db, lead.contact_email)))
    reasons.push('Recipient is on the suppression list');
  if (message.status !== 'approved')
    reasons.push(`Message is not approved (status: ${message.status})`);
  if (sentToday >= cap) reasons.push(`Daily send cap reached (${sentToday}/${cap})`);

  if (lead.contact_email && message.subject && message.body) {
    const v = validateCanSpam(config, lead.contact_email, message.subject, message.body);
    if (!v.ok) reasons.push(...v.problems);
  }

  return { ok: reasons.length === 0, reasons, sentToday, cap };
}
