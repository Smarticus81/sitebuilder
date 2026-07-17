// Scheduled maintenance jobs. Each is idempotent and audit-logged, safe to run
// from cron, the CLI, or an API trigger.

import { logEvent, updateDemo, type DB, type Demo } from '@storefront/db';
import type { DeployProvider } from './deploy.js';
import { slugify } from './slug.js';

export interface UnpublishJobResult {
  examined: number;
  unpublished: number;
  failed: number;
}

/**
 * Tear down every published demo whose TTL (unpublish_at) has passed. The
 * demo row is kept (published=0) so history and analytics survive.
 */
export async function runUnpublishJob(
  deps: { db: DB; deploy: DeployProvider },
  opts: { now?: Date } = {},
): Promise<UnpublishJobResult> {
  const { db, deploy } = deps;
  const now = (opts.now ?? new Date()).toISOString();
  const due = db
    .prepare(
      `SELECT d.*, l.name AS lead_name FROM demos d
       JOIN leads l ON l.id = d.lead_id
       WHERE d.published = 1 AND d.unpublish_at IS NOT NULL AND d.unpublish_at <= ?`,
    )
    .all(now) as (Demo & { lead_name: string })[];

  let unpublished = 0;
  let failed = 0;
  for (const demo of due) {
    const slug = slugify(demo.lead_name);
    try {
      await deploy.unpublish(slug);
      updateDemo(db, demo.id, { published: 0 });
      logEvent(db, 'demo.unpublished', demo.lead_id, {
        demo_id: demo.id,
        slug,
        was_due_at: demo.unpublish_at,
      });
      unpublished++;
    } catch (err) {
      failed++;
      logEvent(db, 'demo.unpublish_failed', demo.lead_id, {
        demo_id: demo.id,
        slug,
        error: String(err).slice(0, 300),
      });
    }
  }
  return { examined: due.length, unpublished, failed };
}
