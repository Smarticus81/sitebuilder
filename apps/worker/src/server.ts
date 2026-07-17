// Worker entrypoint: boot validation → HTTP app → in-process scheduler.
// The app itself lives in app.ts so tests can build it on an ephemeral port.

import './env.js';
import {
  createContext,
  adapterModes,
  validateEnv,
  authEnabled,
  slog,
  alertOperator,
  sendDailyDigest,
  runUnpublishJob,
} from '@storefront/core';
import { buildApp } from './app.js';
import { runSequencesJob } from './stages.js';

const isProduction = process.env.NODE_ENV === 'production';

// ── Boot validation (secrets are validated, never printed) ───────────────────
const report = validateEnv(process.env);
for (const w of report.warnings) slog('warn', 'env.warning', { warning: w });
if (report.errors.length) {
  for (const e of report.errors) slog('error', 'env.error', { error: e });
  if (isProduction) {
    slog('error', 'boot.aborted', { reason: 'invalid environment in production' });
    process.exit(1);
  }
}
if (isProduction && !authEnabled()) {
  slog('error', 'boot.aborted', { reason: 'DASHBOARD_PASSWORD is required in production' });
  process.exit(1);
}
if (isProduction && !process.env.UNSUBSCRIBE_SECRET?.trim()) {
  slog('error', 'boot.aborted', { reason: 'UNSUBSCRIBE_SECRET is required in production' });
  process.exit(1);
}

const ctx = await createContext();
const app = buildApp(ctx);

const port = Number(process.env.WORKER_PORT ?? 8787);
app.listen(port, () => {
  const modes = adapterModes(ctx);
  console.log(`\n  Storefront worker API → http://localhost:${port}`);
  console.log(`  adapters: ${Object.entries(modes).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`  auth: ${authEnabled() ? 'ENABLED' : 'disabled (set DASHBOARD_PASSWORD)'}`);
  console.log(`  demos served at /demos · dashboard talks to /api\n`);
});

// ── In-process scheduler ──────────────────────────────────────────────────────
// Hourly: unpublish expired demos + run due (human-approved) follow-ups.
// Daily: operator digest to the alert webhook. Disable with ENABLE_SCHEDULER=0
// if an external cron hits /api/jobs/* instead.
if (process.env.ENABLE_SCHEDULER !== '0') {
  const HOUR = 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const u = await runUnpublishJob(ctx);
      if (u.examined) slog('info', 'job.unpublish', u as unknown as Record<string, unknown>);
      const s = await runSequencesJob(ctx, {});
      if (s.examined) slog('info', 'job.sequences', { examined: s.examined, sent: s.sent, canceled: s.canceled });
    } catch (e) {
      slog('error', 'job.hourly.failed', { error: String(e) });
      void alertOperator(`Storefront: hourly job failed: ${String(e).slice(0, 200)}`);
    }
  }, HOUR).unref();

  let lastDigestDay = new Date().toISOString().slice(0, 10);
  setInterval(async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today === lastDigestDay) return;
    lastDigestDay = today;
    try {
      await sendDailyDigest(ctx.db);
      slog('info', 'job.digest.sent', { day: today });
    } catch (e) {
      slog('error', 'job.digest.failed', { error: String(e) });
    }
  }, 15 * 60 * 1000).unref();

  slog('info', 'scheduler.started', { hourly: 'unpublish+sequences', daily: 'digest' });
}
