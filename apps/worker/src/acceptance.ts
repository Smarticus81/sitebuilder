import './env.js';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getDb,
  resetDb,
  listLeads,
  getMessageByLead,
  getDemoByLead,
  addSuppression,
  listEvents,
  type Lead,
} from '@storefront/db';
import { createContext, adapterModes, slugify } from '@storefront/core';
import {
  prospect,
  qualifyAll,
  buildOne,
  draftOne,
  approveLeadMessage,
  sendOneMessage,
} from './stages.js';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  const mark = cond ? '✓' : '✗';
  if (!cond) failures++;
  console.log(`  ${mark} ${label}${detail ? `  — ${detail}` : ''}`);
}
function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

async function run() {
  const ctx = createContext();
  console.log('\nStorefront — Phase 1 acceptance (dry-run)');
  console.log(`adapters: ${Object.entries(adapterModes(ctx)).map(([k, v]) => `${k}:${v}`).join('  ')}`);

  // Clean slate — DB rows + generated artifacts, so counts are deterministic.
  resetDb(getDb());
  for (const dir of ['demos-out', resolve('data', 'outbox')]) {
    const abs = resolve(process.cwd(), dir);
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  }
  // re-seed config row (reset cleared it)
  ctx.config; // already loaded; ensure persisted
  const { loadConfig } = await import('@storefront/core');
  loadConfig(getDb());

  // ── 1. Discovery ──────────────────────────────────────────────────────────
  section('Stage 1 — Prospector');
  const p = await prospect(ctx, { category: 'hair salons', location: 'Fort Worth, TX' });
  check('discovery returned operational leads only', p.skipped >= 1, `skipped ${p.skipped} non-operational`);
  check('leads inserted', p.inserted >= 6, `${p.inserted} inserted`);

  // ── 2. Qualify ────────────────────────────────────────────────────────────
  section('Stage 2 — Qualifier (Gate A pauses here)');
  const q = await qualifyAll(ctx);
  const bad = listLeads(ctx.db, 'qualified').filter((l) => l.segment === 'bad');
  const none = listLeads(ctx.db, 'qualified').filter((l) => l.segment === 'none');
  const dropped = listLeads(ctx.db, 'lost');
  check('≥5 bad-website leads (email-reachable)', bad.length >= 5, `${bad.length} bad`);
  check('no-website leads segmented as none', none.length >= 1, `${none.length} none`);
  check('good existing site was DROPPED', dropped.some((l) => l.name.includes('Polished')), `${dropped.length} dropped`);
  check('bad leads have a scraped contact email', bad.every((l) => !!l.contact_email));
  check('leads sorted by score desc', isSortedDesc(bad.map((l) => l.score)));

  const targets = bad.slice(0, 5);

  // ── 3. Gate A → Build 5 demos ─────────────────────────────────────────────
  section('Gate A — approve 5 → Stage 3 Builder');
  for (const lead of targets) await buildOne(ctx, lead.id);
  for (const lead of targets) {
    const demo = getDemoByLead(ctx.db, lead.id)!;
    const slug = slugify(lead.name);
    const file = resolve(process.cwd(), 'demos-out', slug, 'index.html');
    check(`demo built: ${lead.name}`, !!demo?.demo_url && existsSync(file), demo?.demo_url ?? 'no url');
  }
  const builtLeads = targets.map((t) => freshLead(ctx, t.id));
  check('all 5 leads now demo_built', builtLeads.every((l) => l.status === 'demo_built'));
  check('demos have a TTL unpublish date', targets.every((t) => !!getDemoByLead(ctx.db, t.id)?.unpublish_at));

  // ── 4. Gate B → Draft 5 compliant emails ──────────────────────────────────
  section('Gate B — preview demos → Stage 4 Outreach drafts');
  for (const lead of builtLeads) await draftOne(ctx, lead.id);
  for (const lead of builtLeads) {
    const msg = getMessageByLead(ctx.db, lead.id)!;
    const body = msg.body ?? '';
    const hasAddr = body.includes(ctx.config.mailingAddress);
    const hasUnsub = body.includes('unsubscribe?email=');
    const linksDemo = body.includes(getDemoByLead(ctx.db, lead.id)!.demo_url!);
    check(
      `draft compliant: ${lead.name}`,
      msg.status === 'draft' && hasAddr && hasUnsub && linksDemo && !!msg.subject,
      [!hasAddr && 'no address', !hasUnsub && 'no unsubscribe', !linksDemo && 'no demo link']
        .filter(Boolean)
        .join(', ') || 'address+unsubscribe+demo link present',
    );
  }

  // ── 5. Gate C → approve + DRY-RUN send 5 ──────────────────────────────────
  section('Gate C — approve 5 → DRY-RUN send (no mail leaves)');
  // Sending BEFORE approval must be blocked.
  const preApprove = await sendOneMessage(ctx, getMessageByLead(ctx.db, builtLeads[0]!.id)!.id, { dryRun: true });
  check('unapproved draft is blocked at the gate', !preApprove.gate.ok && preApprove.gate.reasons.some((r) => r.includes('not approved')));

  for (const lead of builtLeads) approveLeadMessage(ctx, lead.id, 'acceptance');
  let dryOk = 0;
  for (const lead of builtLeads) {
    const msg = getMessageByLead(ctx.db, lead.id)!;
    const out = await sendOneMessage(ctx, msg.id, { dryRun: true });
    if (out.gate.ok && out.dryRun && !out.sent) dryOk++;
  }
  check('all 5 pass the gate in dry-run, nothing sent', dryOk === 5, `${dryOk}/5`);
  check('messages remain approved (not sent) after dry-run', builtLeads.every((l) => getMessageByLead(ctx.db, l.id)!.status === 'approved'));

  // ── 6. Suppression is enforced ────────────────────────────────────────────
  section('Compliance — suppression check');
  const suppressed = builtLeads[0]!;
  addSuppression(ctx.db, suppressed.contact_email!, 'test: prior unsubscribe');
  const supOut = await sendOneMessage(ctx, getMessageByLead(ctx.db, suppressed.id)!.id, { dryRun: false });
  check('suppressed recipient is blocked (real send)', !supOut.sent && supOut.gate.reasons.some((r) => r.includes('suppression')));

  // ── 7. Daily cap is enforced ──────────────────────────────────────────────
  section('Compliance — daily send cap');
  const originalCap = ctx.config.dailySendCap;
  ctx.config.dailySendCap = 2; // tighten for the test
  const remaining = builtLeads.slice(1); // skip the suppressed one
  let realSent = 0;
  let cappedBlocks = 0;
  for (const lead of remaining) {
    const msg = getMessageByLead(ctx.db, lead.id)!;
    const out = await sendOneMessage(ctx, msg.id, { dryRun: false });
    if (out.sent) realSent++;
    else if (out.gate.reasons.some((r) => r.includes('cap'))) cappedBlocks++;
  }
  ctx.config.dailySendCap = originalCap;
  check('cap stops sends past the limit', realSent === 2 && cappedBlocks >= 1, `sent ${realSent}, capped ${cappedBlocks}`);
  check('exactly the capped number hit the (mock) outbox', countOutbox() === realSent, `${countOutbox()} files`);

  // ── 8. Audit log ──────────────────────────────────────────────────────────
  section('Audit log (events)');
  const events = listEvents(ctx.db);
  const types = new Set(events.map((e) => e.type));
  for (const t of ['lead.discovered', 'lead.qualified', 'demo.built', 'outreach.drafted', 'send.dry_run', 'send.blocked', 'send.sent']) {
    check(`logged: ${t}`, types.has(t));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  section('Result');
  if (failures === 0) {
    console.log('  ✅ Phase 1 acceptance PASSED — full loop ran, every gate held.\n');
    console.log('  Next: `pnpm server` + `pnpm dashboard` to drive the same flow by hand.');
    process.exit(0);
  } else {
    console.log(`  ❌ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
}

function freshLead(ctx: ReturnType<typeof createContext>, id: number): Lead {
  return listLeads(ctx.db).find((l) => l.id === id)!;
}
function isSortedDesc(xs: number[]): boolean {
  return xs.every((x, i) => i === 0 || xs[i - 1]! >= x);
}
function countOutbox(): number {
  const dir = resolve(process.cwd(), 'data', 'outbox');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
