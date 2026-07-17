// Phase E — observability: structured request/error logging, operator
// alerting via a generic webhook (Slack-compatible), and the daily digest.
// The digest deliberately goes to the ALERT WEBHOOK, not email: email stays
// exclusively behind checkSendGate().

import { fetchWithRetry } from '@storefront/net';
import type { DB } from '@storefront/db';
import { computeAnalytics } from './analytics.js';

/** One-line JSON structured log to stdout (12-factor style). */
export function slog(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  // Never spread raw env/config objects in here — fields are caller-curated.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

/**
 * Fire an operator alert to ALERT_WEBHOOK_URL (if configured). Payload is
 * Slack-webhook-compatible ({ text }) and includes no secrets.
 */
export async function alertOperator(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return false;
  try {
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      { service: 'alerts', retries: 2, timeoutMs: 10_000 },
    );
    return res.ok;
  } catch {
    return false; // alerting must never take the pipeline down
  }
}

/** Compose the daily pipeline digest (plain text). */
export async function composeDailyDigest(db: DB): Promise<string> {
  const a = await computeAnalytics(db);
  const t = a.totals;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const lines = [
    `Storefront daily digest — ${new Date().toISOString().slice(0, 10)}`,
    `Pipeline: ${t.leads} leads · ${t.won} won · ${t.lost} lost` +
      (t.closeRate != null ? ` · close rate ${Math.round(t.closeRate * 100)}%` : ''),
    `Outreach: ${t.emailsSent} emails · ${t.smsSent} SMS · ${t.opens} opens · ${t.replies} replies · ${t.demoViews} demo views`,
    `Revenue: ${money(t.oneTimeRevenueCents)} one-time · ${money(t.mrrCents)}/mo MRR`,
  ];
  for (const exp of a.experiments) {
    if (exp.leader && !exp.winner) {
      lines.push(`A/B "${exp.name}": leader is "${exp.leader}" — review in the dashboard to conclude.`);
    }
  }
  return lines.join('\n');
}

/** Send the digest to the alert webhook (no-op without ALERT_WEBHOOK_URL). */
export async function sendDailyDigest(db: DB, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const digest = await composeDailyDigest(db);
  await alertOperator(digest, env);
  return digest;
}
