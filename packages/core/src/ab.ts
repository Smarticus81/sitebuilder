// A/B testing (Phase 4). Variants are assigned deterministically (stable per
// lead), every assignment is persisted + audit-logged, and results are only
// REPORTED — adopting a winner is an explicit human act via concludeExperiment.

import { logEvent, type DB } from '@storefront/db';

export interface ExperimentDef {
  name: string;
  kind: 'subject' | 'template';
  variants: string[];
}

/** Active experiment registry. Adding one here starts splitting new drafts. */
export const EXPERIMENTS: ExperimentDef[] = [
  { name: 'subject-style', kind: 'subject', variants: ['benefit', 'question'] },
  { name: 'template-accent', kind: 'template', variants: ['default', 'warm'] },
];

async function ensureExperimentRow(db: DB, def: ExperimentDef): Promise<void> {
  await db.run(
    `INSERT INTO experiments (name, kind, variants) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING`,
    [def.name, def.kind, JSON.stringify(def.variants)],
  );
}

/**
 * Stable variant for (experiment, lead): first call assigns (lead_id modulo
 * variant count — deterministic, evenly split) and logs; later calls return
 * the recorded assignment unchanged, even after the experiment concludes.
 */
export async function assignVariant(db: DB, experimentName: string, leadId: number): Promise<string> {
  const def = EXPERIMENTS.find((e) => e.name === experimentName);
  if (!def) throw new Error(`Unknown experiment: ${experimentName}`);
  await ensureExperimentRow(db, def);

  const existing = await db.get<{ variant: string }>(
    `SELECT variant FROM ab_assignments WHERE experiment = ? AND lead_id = ?`,
    [experimentName, leadId],
  );
  if (existing) return existing.variant;

  const variant = def.variants[leadId % def.variants.length]!;
  await db.run(`INSERT INTO ab_assignments (experiment, lead_id, variant) VALUES (?, ?, ?)`, [
    experimentName,
    leadId,
    variant,
  ]);
  await logEvent(db, 'ab.assigned', leadId, { experiment: experimentName, variant });
  return variant;
}

/** Human-only: record the winning variant. Changes nothing automatically. */
export async function concludeExperiment(
  db: DB,
  experimentName: string,
  winner: string,
  concludedBy: string,
): Promise<void> {
  const def = EXPERIMENTS.find((e) => e.name === experimentName);
  if (!def) throw new Error(`Unknown experiment: ${experimentName}`);
  if (!def.variants.includes(winner))
    throw new Error(`"${winner}" is not a variant of ${experimentName} (${def.variants.join(', ')})`);
  await ensureExperimentRow(db, def);
  await db.run(
    `UPDATE experiments SET winner = ?, concluded_by = ?, concluded_at = ${db.nowSql} WHERE name = ?`,
    [winner, concludedBy, experimentName],
  );
  await logEvent(db, 'ab.concluded', null, { experiment: experimentName, winner, concluded_by: concludedBy });
}

export interface VariantReport {
  variant: string;
  leads: number;
  sent: number;
  replies: number;
  won: number;
  replyRate: number | null;
}

export interface ExperimentReport {
  name: string;
  kind: string;
  winner: string | null;
  concludedBy: string | null;
  leader: string | null; // reported, never auto-adopted
  variants: VariantReport[];
}

export async function experimentReport(db: DB): Promise<ExperimentReport[]> {
  const reports: ExperimentReport[] = [];
  for (const def of EXPERIMENTS) {
    await ensureExperimentRow(db, def);
    const row = await db.get<{ winner: string | null; concluded_by: string | null }>(
      `SELECT winner, concluded_by FROM experiments WHERE name = ?`,
      [def.name],
    );
    const variants: VariantReport[] = [];
    for (const variant of def.variants) {
      const stats = (await db.get<{ leads: number; sent: number; replies: number; won: number }>(
        `SELECT
           COUNT(DISTINCT a.lead_id) AS leads,
           COUNT(DISTINCT CASE WHEN m.status = 'sent' THEN m.lead_id END) AS sent,
           COUNT(DISTINCT CASE WHEN e.type = 'reply.received' THEN e.lead_id END) AS replies,
           COUNT(DISTINCT CASE WHEN l.status = 'won' THEN l.id END) AS won
         FROM ab_assignments a
         JOIN leads l ON l.id = a.lead_id
         LEFT JOIN messages m ON m.lead_id = a.lead_id AND m.channel = 'email'
         LEFT JOIN events e ON e.lead_id = a.lead_id AND e.type = 'reply.received'
         WHERE a.experiment = ? AND a.variant = ?`,
        [def.name, variant],
      ))!;
      variants.push({
        variant,
        leads: stats.leads,
        sent: stats.sent,
        replies: stats.replies,
        won: stats.won,
        replyRate: stats.sent > 0 ? stats.replies / stats.sent : null,
      });
    }
    const withData = variants.filter((v) => v.sent > 0);
    const leader =
      withData.length > 1
        ? [...withData].sort((a, b) => (b.replyRate ?? 0) - (a.replyRate ?? 0))[0]!.variant
        : null;
    reports.push({
      name: def.name,
      kind: def.kind,
      winner: row?.winner ?? null,
      concludedBy: row?.concluded_by ?? null,
      leader,
      variants,
    });
  }
  return reports;
}
