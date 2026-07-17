// Phase 4 — pipeline analytics, computed straight from the local DB (leads,
// messages, sms, proposals) and the audit log. No external calls.

import { logEvent, type DB } from '@storefront/db';
import { experimentReport, type ExperimentReport } from './ab.js';

export interface AnalyticsTotals {
  leads: number;
  emailsSent: number;
  smsSent: number;
  opens: number;
  replies: number;
  demoViews: number;
  won: number;
  lost: number;
  /** won / (won + lost), among decided leads. */
  closeRate: number | null;
  mrrCents: number;
  oneTimeRevenueCents: number;
}

export interface BreakdownRow {
  key: string;
  leads: number;
  demosBuilt: number;
  emailsSent: number;
  replies: number;
  won: number;
}

export interface Analytics {
  totals: AnalyticsTotals;
  byTemplate: BreakdownRow[];
  bySegment: BreakdownRow[];
  experiments: ExperimentReport[];
}

const n = (db: DB, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

export function computeAnalytics(db: DB): Analytics {
  const won = n(db, `SELECT COUNT(*) n FROM leads WHERE status = 'won'`);
  const lost = n(db, `SELECT COUNT(*) n FROM leads WHERE status = 'lost'`);

  const totals: AnalyticsTotals = {
    leads: n(db, `SELECT COUNT(*) n FROM leads`),
    emailsSent: n(db, `SELECT COUNT(*) n FROM messages WHERE channel = 'email' AND status = 'sent'`),
    smsSent: n(db, `SELECT COUNT(*) n FROM sms_messages WHERE status = 'sent'`),
    opens: n(db, `SELECT COUNT(*) n FROM events WHERE type = 'open.recorded'`),
    replies: n(db, `SELECT COUNT(*) n FROM events WHERE type = 'reply.received'`),
    demoViews: n(db, `SELECT COUNT(*) n FROM events WHERE type = 'demo.viewed'`),
    won,
    lost,
    closeRate: won + lost > 0 ? won / (won + lost) : null,
    mrrCents:
      (db
        .prepare(
          `SELECT COALESCE(SUM(p.monthly_cents), 0) s FROM leads l
           JOIN proposals p ON p.id = (
             SELECT id FROM proposals WHERE lead_id = l.id ORDER BY id DESC LIMIT 1
           )
           WHERE l.status = 'won'`,
        )
        .get() as { s: number }).s,
    oneTimeRevenueCents:
      (db
        .prepare(
          `SELECT COALESCE(SUM(p.price_cents), 0) s FROM leads l
           JOIN proposals p ON p.id = (
             SELECT id FROM proposals WHERE lead_id = l.id ORDER BY id DESC LIMIT 1
           )
           WHERE l.status = 'won'`,
        )
        .get() as { s: number }).s,
  };

  const breakdown = (keyExpr: string, join: string): BreakdownRow[] =>
    db
      .prepare(
        `SELECT ${keyExpr} AS key,
           COUNT(DISTINCT l.id) AS leads,
           COUNT(DISTINCT d.lead_id) AS demosBuilt,
           COUNT(DISTINCT CASE WHEN m.status = 'sent' THEN m.lead_id END) AS emailsSent,
           COUNT(DISTINCT CASE WHEN e.type = 'reply.received' THEN e.lead_id END) AS replies,
           COUNT(DISTINCT CASE WHEN l.status = 'won' THEN l.id END) AS won
         FROM leads l
         ${join}
         LEFT JOIN messages m ON m.lead_id = l.id AND m.channel = 'email'
         LEFT JOIN events e ON e.lead_id = l.id AND e.type = 'reply.received'
         GROUP BY key HAVING key IS NOT NULL ORDER BY leads DESC`,
      )
      .all() as BreakdownRow[];

  return {
    totals,
    byTemplate: breakdown(
      'd.template',
      `LEFT JOIN demos d ON d.id = (SELECT id FROM demos WHERE lead_id = l.id ORDER BY id DESC LIMIT 1)`,
    ),
    bySegment: breakdown(
      'l.segment',
      `LEFT JOIN demos d ON d.id = (SELECT id FROM demos WHERE lead_id = l.id ORDER BY id DESC LIMIT 1)`,
    ),
    experiments: experimentReport(db),
  };
}

/** Beacon hit → demo.viewed audit event (slug → lead via latest demo). */
export function recordDemoView(db: DB, slug: string): boolean {
  const row = db
    .prepare(
      `SELECT d.lead_id AS leadId FROM demos d JOIN leads l ON l.id = d.lead_id
       WHERE d.subdomain LIKE ? || '.%' OR d.subdomain = ?
       ORDER BY d.id DESC LIMIT 1`,
    )
    .get(slug, slug) as { leadId: number } | undefined;
  if (!row) return false;
  logEvent(db, 'demo.viewed', row.leadId, { slug });
  return true;
}
