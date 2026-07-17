import './env.js';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fetchJson, fetchWithRetry, AdapterError } from '@storefront/net';
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
  for (const dir of ['demos-out', 'proposals-out', resolve('data', 'outbox'), resolve('data', 'sms-outbox')]) {
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
  const audits = bad.map((l) => JSON.parse(l.audit_json ?? 'null') as {
    lighthouse: { performance: number | null; seo: number | null; accessibility: number | null; bestPractices: number | null } | null;
  } | null);
  check(
    'audits carry all four Lighthouse categories (perf/seo/a11y/best-practices)',
    audits.every(
      (a) =>
        a?.lighthouse != null &&
        a.lighthouse.performance != null &&
        a.lighthouse.seo != null &&
        a.lighthouse.accessibility != null &&
        a.lighthouse.bestPractices != null,
    ),
  );

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

  // ── 9. Phase B: five industry templates on the shared engine ──────────────
  section('Phase B — industry templates (restaurant, trades, auto, med spa)');
  const { templateKeyFor } = await import('@storefront/core');
  const expectTemplates: Record<string, string> = {
    restaurant: 'restaurant',
    plumber: 'contractor',
    'auto repair': 'auto-shop',
    'med spa': 'dental-medspa',
  };
  for (const cat of Object.keys(expectTemplates)) {
    await prospect(ctx, { category: cat, location: 'Fort Worth, TX' });
  }
  await qualifyAll(ctx);
  const newBad = listLeads(ctx.db, 'qualified').filter((l) => l.segment === 'bad');
  check('one bad-site lead per new industry', newBad.length === 4, `${newBad.length} qualified`);

  for (const lead of newBad) await buildOne(ctx, lead.id);
  const { readFileSync } = await import('node:fs');
  for (const [cat, expected] of Object.entries(expectTemplates)) {
    const lead = newBad.find((l) => templateKeyFor(l.category) === expected);
    const demo = lead ? getDemoByLead(ctx.db, lead.id) : undefined;
    const file = lead ? resolve(process.cwd(), 'demos-out', slugify(lead.name), 'index.html') : '';
    const html = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
    check(
      `"${cat}" lead renders the ${expected} template`,
      !!demo && demo.template === expected && html.includes(`data-template="${expected}"`),
      lead?.name ?? 'no matching lead',
    );
    check(
      `${expected} demo is self-contained + mobile-first (no scripts/external CSS, has viewport)`,
      !!html &&
        html.includes('name="viewport"') &&
        !html.includes('<script') &&
        !html.includes('rel="stylesheet"'),
    );
    check(
      `${expected} demo carries the demo-preview banner`,
      !!html && html.includes('Demo preview prepared by'),
    );
  }
  check('unknown category falls back to the default template', templateKeyFor('tanning_studio_xyz') === 'salon-barber');
  check(
    'industry templates render distinct section headings',
    ['From the kitchen', 'What we handle', 'In the bay', 'Treatments'].every((h) =>
      newBad.some((l) => {
        const f = resolve(process.cwd(), 'demos-out', slugify(l.name), 'index.html');
        return existsSync(f) && readFileSync(f, 'utf8').includes(h);
      }),
    ),
  );

  // ── 10. Phase B: follow-up sequencing ───────────────────────────────────────
  section('Phase B — follow-up sequencing (gated, spaced, auto-canceling)');
  await testSequencing(ctx);

  // ── 11. Phase B: auto-unpublish + reply detection ──────────────────────────
  section('Phase B — auto-unpublish job + reply/bounce detection');
  await testUnpublishAndReplies(ctx);

  // ── 12. Phase C: none-segment — call scripts + TCPA-gated SMS ──────────────
  section('Phase C — call scripts + "text the demo" SMS (TCPA-gated)');
  await testNoneSegment(ctx);

  // ── 13. Phase C: close & convert ────────────────────────────────────────────
  section('Phase C — proposals, domain requests (approval-only), won/lost');
  await testCloseFlow(ctx);

  // ── 14. Phase D: analytics + A/B ─────────────────────────────────────────────
  section('Phase D — analytics, demo views, opens, A/B experiments');
  await testAnalyticsAndAb(ctx);

  // ── 15. Adapter hardening: retry / backoff / timeout ───────────────────────
  section('Phase A — adapter hardening (retry, Retry-After, timeout)');
  await testAdapterHardening(ctx);

  // ── 10. Env validation (drives `pnpm doctor` and boot checks) ─────────────
  section('Phase A — environment validation');
  const { validateEnv } = await import('@storefront/core');
  const goodEnv = validateEnv(process.env);
  check('example .env validates clean (no errors)', goodEnv.errors.length === 0, goodEnv.errors.join('; '));
  const badEnv = validateEnv({ ...process.env, MAILING_ADDRESS: '', REPLY_TO: 'not-an-email', FROM_DOMAIN: 'outreach.example.com' });
  check(
    'missing address / bad reply-to / example domain are all caught',
    badEnv.errors.some((e) => e.includes('MAILING_ADDRESS')) &&
      badEnv.errors.some((e) => e.includes('REPLY_TO')) &&
      badEnv.errors.some((e) => e.includes('FROM_DOMAIN')),
  );
  check('apex FROM_DOMAIN warns toward a dedicated subdomain',
    validateEnv({ ...process.env, FROM_DOMAIN: 'mydomain.com' }).warnings.some((w) => w.includes('subdomain')));
  check('adapter modes include the audit provider', 'audit' in adapterModes(ctx));

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

/**
 * Follow-up sequencing: drafts stay unsendable until a human approves the
 * sequence; spacing (≥4 days) is enforced; every step passes checkSendGate;
 * replies and unsubscribes auto-cancel; max 2 follow-ups, ever.
 */
async function testSequencing(ctx: ReturnType<typeof createContext>) {
  const {
    draftFollowupSequence, approveSequence, runSequences, MAX_FOLLOWUPS,
  } = await import('@storefront/core');
  const { listSequenceMessages, getSequence, addSuppression: suppress, setLeadStatus, listEvents } =
    await import('@storefront/db');
  const backdate = (leadId: number) =>
    ctx.db
      .prepare(`UPDATE messages SET sent_at = datetime('now', '-5 days') WHERE lead_id = ? AND status = 'sent'`)
      .run(leadId);

  const contacted = listLeads(ctx.db, 'contacted');
  check('two contacted leads available for sequencing', contacted.length >= 2, `${contacted.length}`);
  const [l1, l2] = contacted as [Lead, Lead];

  // Draft: automation may prepare, never send.
  const s1 = draftFollowupSequence(ctx.db, ctx.config, l1);
  check('sequence drafted with exactly MAX_FOLLOWUPS steps', s1.messages.length === MAX_FOLLOWUPS && MAX_FOLLOWUPS === 2);
  check('sequence spacing floor is ≥ 4 days', s1.sequence.spacing_days >= 4);
  check(
    'follow-up drafts carry the CAN-SPAM footer + demo link',
    s1.messages.every(
      (m) => m.body!.includes('unsubscribe?email=') && m.body!.includes(ctx.config.mailingAddress) && m.body!.includes(l1.demo_url!),
    ),
  );
  const preApproveSend = await sendOneMessage(ctx, s1.messages[0]!.id, { dryRun: true });
  check('unapproved follow-up is blocked by the send gate', !preApproveSend.gate.ok);
  const r0 = await runSequences(ctx, {});
  check('runner ignores unapproved sequences', r0.examined === 0 && r0.sent === 0);

  // Human approves the sequence (Gate: explicit action).
  approveSequence(ctx.db, s1.sequence.id, 'acceptance-operator');
  check(
    'approval marks sequence + steps approved with the approver recorded',
    getSequence(ctx.db, s1.sequence.id)!.status === 'approved' &&
      listSequenceMessages(ctx.db, s1.sequence.id).every((m) => m.status === 'approved' && m.approved_by === 'acceptance-operator'),
  );

  // Spacing: nothing is due immediately after the initial send.
  const r1 = await runSequences(ctx, {});
  check('spacing blocks a follow-up sent too soon', r1.sent === 0 && r1.skippedNotDue === 1);

  // Backdate the initial send 5 days → step 1 becomes due and passes the gate.
  backdate(l1.id);
  const r2 = await runSequences(ctx, {});
  check('due follow-up sends through checkSendGate', r2.sent === 1);

  // Reply auto-cancels the rest.
  setLeadStatus(ctx.db, l1.id, 'replied');
  const r3 = await runSequences(ctx, {});
  const s1After = getSequence(ctx.db, s1.sequence.id)!;
  check(
    'reply auto-cancels the sequence and voids the unsent step',
    r3.canceled === 1 && s1After.status === 'canceled' &&
      listSequenceMessages(ctx.db, s1.sequence.id).some((m) => m.status === 'canceled'),
  );

  // Full-completion path (fresh sequence on the same lead after cancel).
  setLeadStatus(ctx.db, l1.id, 'contacted');
  const s2 = draftFollowupSequence(ctx.db, ctx.config, freshLead(ctx, l1.id));
  approveSequence(ctx.db, s2.sequence.id, 'acceptance-operator');
  backdate(l1.id);
  await runSequences(ctx, {});
  backdate(l1.id);
  const r4 = await runSequences(ctx, {});
  check(
    'sequence completes after exactly 2 follow-ups',
    r4.completed === 1 &&
      getSequence(ctx.db, s2.sequence.id)!.status === 'completed' &&
      listSequenceMessages(ctx.db, s2.sequence.id).filter((m) => m.status === 'sent').length === 2,
  );
  let thirdErr = '';
  try {
    draftFollowupSequence(ctx.db, ctx.config, freshLead(ctx, l1.id));
  } catch (e) {
    thirdErr = (e as Error).message;
  }
  check('a third follow-up round cannot be drafted', thirdErr.includes('already has'));

  // Unsubscribe/suppression auto-cancels before any send.
  const s3 = draftFollowupSequence(ctx.db, ctx.config, l2);
  approveSequence(ctx.db, s3.sequence.id, 'acceptance-operator');
  suppress(ctx.db, l2.contact_email!, 'test: unsubscribed mid-sequence');
  backdate(l2.id);
  const r5 = await runSequences(ctx, {});
  check(
    'unsubscribe auto-cancels the sequence with zero sends',
    r5.canceled === 1 && r5.sent === 0 && getSequence(ctx.db, s3.sequence.id)!.status === 'canceled',
  );

  const seqEvents = new Set(listEvents(ctx.db).map((e) => e.type));
  for (const t of ['sequence.drafted', 'sequence.approved', 'sequence.step_sent', 'sequence.canceled', 'sequence.completed']) {
    check(`logged: ${t}`, seqEvents.has(t));
  }
}

/**
 * Analytics + A/B: metrics derive from the pipeline the earlier sections
 * built; variant assignment is deterministic + logged; winners are only
 * reported — concluding is a human act and changes no behavior.
 */
async function testAnalyticsAndAb(ctx: ReturnType<typeof createContext>) {
  const {
    computeAnalytics, recordDemoView, handleInboundEvent, assignVariant, concludeExperiment, EXPERIMENTS,
  } = await import('@storefront/core');
  const { listEvents } = await import('@storefront/db');

  // A/B assignment happened during draft/build stages — verify it's logged + stable.
  const assigned = ctx.db.prepare(`SELECT COUNT(*) n FROM ab_assignments`).get() as { n: number };
  check('A/B assignments were recorded during draft/build', assigned.n >= 10, `${assigned.n} assignments`);
  check('every assignment has an ab.assigned audit event',
    listEvents(ctx.db).filter((e) => e.type === 'ab.assigned').length >= assigned.n);
  const someLead = listLeads(ctx.db).find((l) => l.status !== 'discovered')!;
  const v1 = assignVariant(ctx.db, 'subject-style', someLead.id);
  const v2 = assignVariant(ctx.db, 'subject-style', someLead.id);
  check('variant assignment is stable per lead', v1 === v2);
  const variants = new Set(
    (ctx.db.prepare(`SELECT DISTINCT variant FROM ab_assignments WHERE experiment='subject-style'`).all() as { variant: string }[])
      .map((r) => r.variant),
  );
  check('both subject variants are in play', variants.has('benefit') && variants.has('question'));
  const questionSubject = ctx.db
    .prepare(
      `SELECT COUNT(*) n FROM messages m JOIN ab_assignments a
        ON a.lead_id = m.lead_id AND a.experiment = 'subject-style' AND a.variant = 'question'
       WHERE m.channel = 'email' AND m.followup_step IS NULL AND m.subject LIKE 'Quick question%'`,
    )
    .get() as { n: number };
  check('question-variant drafts actually use the alternate subject', questionSubject.n >= 1, `${questionSubject.n}`);

  // Demo views (beacon) + opens (provider webhook).
  const viewed = recordDemoView(ctx.db, slugify(someLead.name));
  check('demo-view beacon resolves slug → lead and logs demo.viewed',
    viewed && listEvents(ctx.db, someLead.id).some((e) => e.type === 'demo.viewed'));
  check('unknown beacon slugs are ignored safely', recordDemoView(ctx.db, 'not-a-real-slug') === false);
  const opened = listLeads(ctx.db).find((l) => !!l.contact_email)!;
  handleInboundEvent(ctx.db, { kind: 'open', email: opened.contact_email! });
  check('email.opened events record opens', listEvents(ctx.db).some((e) => e.type === 'open.recorded'));

  // Analytics numbers line up with what this run actually did.
  const a = computeAnalytics(ctx.db);
  check('analytics: sends/replies/close figures match pipeline state',
    a.totals.emailsSent >= 4 && a.totals.smsSent === 1 && a.totals.replies >= 1 &&
      a.totals.won === 1 && a.totals.lost >= 1 && a.totals.closeRate! > 0,
    `emails ${a.totals.emailsSent}, sms ${a.totals.smsSent}, replies ${a.totals.replies}, won ${a.totals.won}`);
  check('analytics: MRR comes from the won lead\'s proposal', a.totals.mrrCents === 5000, `${a.totals.mrrCents}c`);
  check('analytics: per-template breakdown covers all built templates', a.byTemplate.length >= 5, `${a.byTemplate.length} templates`);
  check('analytics: per-segment breakdown present', a.bySegment.some((r) => r.key === 'bad') && a.bySegment.some((r) => r.key === 'none'));

  // Winners: reported, never auto-promoted.
  const report = a.experiments.find((e) => e.name === 'subject-style')!;
  check('experiment report lists both variants with stats', report.variants.length === 2 && report.winner === null);
  concludeExperiment(ctx.db, 'subject-style', 'question', 'human-operator');
  const after = computeAnalytics(ctx.db).experiments.find((e) => e.name === 'subject-style')!;
  check('human conclusion recorded with the decider', after.winner === 'question' && after.concludedBy === 'human-operator');
  const unassigned = listLeads(ctx.db).find(
    (l) =>
      !ctx.db
        .prepare(`SELECT 1 FROM ab_assignments WHERE experiment = 'subject-style' AND lead_id = ?`)
        .get(l.id),
  )!;
  const freshVariant = assignVariant(ctx.db, 'subject-style', unassigned.id);
  check(
    'conclusion does NOT auto-promote — new assignments still split deterministically',
    freshVariant === EXPERIMENTS[0]!.variants[unassigned.id % 2]!,
    `lead ${unassigned.id} → ${freshVariant}`,
  );
}

/**
 * Close & convert: proposal page + customer-initiated payment link; domain
 * purchases are approval-link-only (never bought by the system); won/lost
 * always records a reason.
 */
async function testCloseFlow(ctx: ReturnType<typeof createContext>) {
  const { createProposal, requestDomainPurchase, decideDomainRequest, closeLead } =
    await import('@storefront/core');
  const { getLead, getProposalByLead, listEvents } = await import('@storefront/db');
  const { readFileSync } = await import('node:fs');

  const lead = listLeads(ctx.db, 'contacted').find((l) => !!l.demo_url);
  check('a contacted lead with a demo exists for closing', !!lead, lead?.name ?? 'none');
  if (!lead) return;

  // Proposal: page + payment link (mock Stripe → deterministic URL).
  const proposal = await createProposal(ctx, lead);
  const file = resolve(process.cwd(), 'proposals-out', proposal.slug, 'index.html');
  const html = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check('proposal row persisted with payment link', !!getProposalByLead(ctx.db, lead.id)?.payment_link_url);
  check(
    'proposal page renders demo link + payment CTA + price',
    html.includes(lead.demo_url!) && html.includes(proposal.payment_link_url!) && html.includes('$1,500'),
  );
  check(
    'payment is customer-initiated only (page says nothing is charged automatically)',
    html.includes('Nothing is charged until you choose to pay'),
  );
  const noDemo = listLeads(ctx.db, 'lost').find((l) => !l.demo_url);
  if (noDemo) {
    let err = '';
    await createProposal(ctx, noDemo).catch((e) => (err = (e as Error).message));
    check('proposal refuses without a demo (Gate A first)', err.includes('Gate A'));
  }

  // Domain purchase REQUEST — approval link only.
  const dr = requestDomainPurchase(ctx.db, lead, 'TaqueriaLaFamiliaFW.com', 'acceptance');
  check(
    'domain request minted with approve/decline links (status requested)',
    dr.request.status === 'requested' && dr.approveUrl.includes(dr.request.token) && dr.request.domain === 'taquerialafamiliafw.com',
  );
  let badDomainErr = '';
  try {
    requestDomainPurchase(ctx.db, lead, 'not a domain', 'acceptance');
  } catch (e) {
    badDomainErr = (e as Error).message;
  }
  check('invalid domain names are rejected', badDomainErr.includes('does not look like'));
  const decided = decideDomainRequest(ctx.db, dr.request.token, 'approved', 'human-operator');
  check('human decision recorded (approved, decider logged)', decided.status === 'approved' && decided.decided_by === 'human-operator');
  const redecided = decideDomainRequest(ctx.db, dr.request.token, 'declined', 'someone-else');
  check('decision is idempotent — first human decision wins', redecided.status === 'approved');
  check(
    'no purchase event exists anywhere (requests never buy)',
    !listEvents(ctx.db).some((e) => e.type.includes('purchase')),
  );

  // Won/lost with reasons.
  let reasonErr = '';
  try {
    closeLead(ctx.db, lead.id, 'won', '   ');
  } catch (e) {
    reasonErr = (e as Error).message;
  }
  check('closing without a reason is refused', reasonErr.includes('reason is required'));
  const won = closeLead(ctx.db, lead.id, 'won', 'accepted proposal after SMS demo');
  check(
    'won close records reason + timestamp + audit event',
    won.status === 'won' && won.close_reason === 'accepted proposal after SMS demo' && !!won.closed_at &&
      listEvents(ctx.db, lead.id).some((e) => e.type === 'lead.won'),
  );
  const loser = listLeads(ctx.db, 'contacted')[0];
  if (loser) {
    const lost = closeLead(ctx.db, loser.id, 'lost', 'went with a competitor');
    check('lost close records reason too', lost.status === 'lost' && lost.close_reason === 'went with a competitor');
  }
}

/**
 * None-segment (phone-first): call scripts draft for the operator; "text the
 * demo" SMS has its OWN gate — human approval with a documented TCPA basis,
 * STOP language, quiet hours, daily cap, and permanent opt-out.
 */
async function testNoneSegment(ctx: ReturnType<typeof createContext>) {
  const {
    draftCallScript, draftDemoSms, approveSms, sendApprovedSms, recordSmsOptOut, smsPolicy,
  } = await import('@storefront/core');
  const { getLead, getSms, listEvents } = await import('@storefront/db');

  const noneLead = listLeads(ctx.db, 'qualified').find((l) => l.segment === 'none' && !!l.phone);
  check('a phone-first none-segment lead exists', !!noneLead, noneLead?.name ?? 'none found');
  if (!noneLead) return;

  // Call scripts never reach the email wire.
  const script = draftCallScript(ctx.db, ctx.config, noneLead);
  check(
    'call script drafted for the operator (channel call_script)',
    script.channel === 'call_script' && script.body!.includes(noneLead.phone!) && script.status === 'draft',
  );
  let scriptSendErr = '';
  try {
    ctx.db.prepare(`UPDATE messages SET status='approved' WHERE id=?`).run(script.id);
    await sendOneMessage(ctx, script.id, { dryRun: true });
  } catch (e) {
    scriptSendErr = (e as Error).message;
  }
  check('an approved call script still cannot be emailed', scriptSendErr.includes('not sendable as email'));

  // SMS needs a built demo (Gate A is per-lead and explicit).
  let noDemoErr = '';
  try {
    draftDemoSms(ctx.db, ctx.config, noneLead);
  } catch (e) {
    noDemoErr = (e as Error).message;
  }
  check('SMS draft refuses without a demo (Gate A first)', noDemoErr.includes('Gate A'));
  await buildOne(ctx, noneLead.id);
  const built = getLead(ctx.db, noneLead.id)!;
  const sms = draftDemoSms(ctx.db, ctx.config, built);
  check(
    'SMS draft carries demo link + STOP opt-out language',
    sms.body.includes(built.demo_url!) && sms.body.includes('Reply STOP'),
  );

  // Inside-window clock for deterministic gate checks (2pm local).
  const policy = smsPolicy(process.env);
  const daytime = new Date(Date.UTC(2026, 6, 17, (14 - policy.tzOffsetHours) % 24, 0, 0));

  // Gate: unapproved SMS is blocked.
  const preApprove = await sendApprovedSms(ctx, sms.id, { dryRun: true, now: daytime });
  check('unapproved SMS is blocked at the gate', !preApprove.gate.ok && preApprove.gate.reasons.some((r) => r.includes('not approved')));

  // Gate: approval REQUIRES a documented TCPA basis.
  let basisErr = '';
  try {
    approveSms(ctx.db, sms.id, 'acceptance', '');
  } catch (e) {
    basisErr = (e as Error).message;
  }
  check('approval without a TCPA basis is refused', basisErr.includes('TCPA basis required'));
  approveSms(ctx.db, sms.id, 'acceptance', 'Owner said OK to text on discovery call 2026-07-16 (see CRM note #42)');
  check('TCPA basis + approver recorded on the SMS', getSms(ctx.db, sms.id)!.tcpa_basis!.includes('CRM note') && getSms(ctx.db, sms.id)!.approved_by === 'acceptance');

  // Gate: quiet hours (10pm local is blocked even when approved).
  const night = new Date(Date.UTC(2026, 6, 17, (22 - policy.tzOffsetHours) % 24, 0, 0));
  const nightOut = await sendApprovedSms(ctx, sms.id, { dryRun: true, now: night });
  check('quiet hours block texts at 10pm local', !nightOut.gate.ok && nightOut.gate.reasons.some((r) => r.includes('send window')));

  // Dry-run passes in the daytime, nothing sent.
  const dry = await sendApprovedSms(ctx, sms.id, { dryRun: true, now: daytime });
  check('approved SMS passes the gate in dry-run (nothing sent)', dry.gate.ok && !dry.sent && getSms(ctx.db, sms.id)!.status === 'approved');

  // Real (mock) send → sms-outbox file + lead contacted.
  const real = await sendApprovedSms(ctx, sms.id, { now: daytime });
  const smsOutbox = resolve(process.cwd(), 'data', 'sms-outbox');
  check(
    'approved SMS sends via the mock provider to sms-outbox',
    real.sent && existsSync(smsOutbox) && readdirSync(smsOutbox).length === 1,
  );
  check('SMS contact advances the lead to contacted', getLead(ctx.db, noneLead.id)!.status === 'contacted');

  // STOP → permanent opt-out; further sends blocked.
  recordSmsOptOut(ctx.db, built.phone!, built.id);
  const sms2 = draftDemoSms(ctx.db, ctx.config, getLead(ctx.db, built.id)!);
  approveSms(ctx.db, sms2.id, 'acceptance', 'same documented consent as sms #1 (CRM note #42)');
  const blocked = await sendApprovedSms(ctx, sms2.id, { now: daytime });
  check('STOP opt-out permanently blocks future texts', !blocked.sent && blocked.gate.reasons.some((r) => r.includes('opted out')));

  const smsEvents = new Set(listEvents(ctx.db).map((e) => e.type));
  for (const t of ['callscript.drafted', 'sms.drafted', 'sms.approved', 'sms.dry_run', 'sms.sent', 'sms.blocked', 'sms.opt_out']) {
    check(`logged: ${t}`, smsEvents.has(t));
  }
}

/**
 * Auto-unpublish: demos past their TTL are torn down (files removed, row kept
 * with published=0) and logged. Reply/bounce/complaint fixtures drive the same
 * handler the Resend webhook uses.
 */
async function testUnpublishAndReplies(ctx: ReturnType<typeof createContext>) {
  const { runUnpublishJob, parseResendWebhook, handleInboundEvent, verifyResendSignature } =
    await import('@storefront/core');
  const { listEvents, isSuppressed, getLead } = await import('@storefront/db');

  // TTLs are ~14 days out; nothing should be due today…
  const early = await runUnpublishJob(ctx, {});
  check('unpublish job is a no-op before any TTL expires', early.examined === 0);

  // …but everything is due 15 days from now.
  const publishedBefore = (ctx.db.prepare(`SELECT COUNT(*) n FROM demos WHERE published = 1`).get() as { n: number }).n;
  const future = new Date(Date.now() + 15 * 86_400_000);
  const late = await runUnpublishJob(ctx, { now: future });
  check(
    `TTL fires: all ${publishedBefore} published demos torn down`,
    late.unpublished === publishedBefore && late.failed === 0,
    `${late.unpublished}/${late.examined}`,
  );
  check('demo files are actually gone', !existsSync(resolve(process.cwd(), 'demos-out', 'taqueria-la-familia')));
  check(
    'demo rows survive with published=0 (history kept)',
    (ctx.db.prepare(`SELECT COUNT(*) n FROM demos WHERE published = 0`).get() as { n: number }).n === publishedBefore,
  );
  check('logged: demo.unpublished', listEvents(ctx.db).some((e) => e.type === 'demo.unpublished'));

  // Reply detection — fixture inbound events in the Resend wire format.
  const taqueria = listLeads(ctx.db).find((l) => l.name.includes('Taqueria'))!;
  const replyEvt = parseResendWebhook({
    type: 'email.received',
    data: { from: `Taqueria La Familia <${taqueria.contact_email}>`, subject: 'Re: your preview' },
  });
  check('inbound reply payload parses (display-name form)', replyEvt?.kind === 'reply' && replyEvt.email === taqueria.contact_email);
  const replyRes = handleInboundEvent(ctx.db, replyEvt!);
  check(
    'reply flips the lead to replied + logs reply.received',
    replyRes.matched &&
      getLead(ctx.db, taqueria.id)!.status === 'replied' &&
      listEvents(ctx.db, taqueria.id).some((e) => e.type === 'reply.received'),
  );

  const plumber = listLeads(ctx.db).find((l) => l.name.includes('Big Tex'))!;
  const bounceEvt = parseResendWebhook({ type: 'email.bounced', data: { to: [plumber.contact_email!] } });
  handleInboundEvent(ctx.db, bounceEvt!);
  check(
    'bounce suppresses the address permanently',
    isSuppressed(ctx.db, plumber.contact_email!) &&
      listEvents(ctx.db, plumber.id).some((e) => e.type === 'bounce.recorded'),
  );

  const unknown = handleInboundEvent(ctx.db, { kind: 'reply', email: 'stranger@nowhere.example' });
  check('unmatched inbound addresses are logged, not crashed', !unknown.matched);

  // Webhook signature verification (svix scheme).
  const { createHmac } = await import('node:crypto');
  const secret = 'whsec_' + Buffer.from('test-secret-key-32-bytes-long!!').toString('base64');
  const body = JSON.stringify({ type: 'email.received', data: { from: 'a@b.c' } });
  const id = 'msg_1';
  const ts = '1700000000';
  const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${ts}.${body}`)
    .digest('base64');
  check(
    'valid webhook signature accepted, tampered rejected',
    verifyResendSignature(secret, { id, timestamp: ts, signature: `v1,${sig}` }, body) &&
      !verifyResendSignature(secret, { id, timestamp: ts, signature: `v1,${sig}` }, body + 'x'),
  );
}

/**
 * Exercises @storefront/net against a throwaway local HTTP server: transient
 * 5xx recovery, Retry-After honoring, no-retry on 4xx, per-attempt timeout,
 * and structured adapter.* events flowing into the audit log.
 */
async function testAdapterHardening(ctx: ReturnType<typeof createContext>) {
  const hits: Record<string, number> = {};
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === '/flaky') {
      if (hits[path]! <= 2) {
        res.writeHead(500).end('boom');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      }
    } else if (path === '/rate') {
      if (hits[path]! === 1) {
        res.writeHead(429, { 'Retry-After': '0' }).end('slow down');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      }
    } else if (path === '/bad') {
      res.writeHead(400).end('bad request');
    } else if (path === '/hang') {
      // never respond — forces the per-attempt timeout
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const { logEvent } = await import('@storefront/db');
  const log = (type: string, payload: Record<string, unknown>) =>
    logEvent(ctx.db, type, null, payload);
  const fast = { baseDelayMs: 5, maxDelayMs: 20, log };

  try {
    const flaky = await fetchJson<{ ok: boolean }>(`${base}/flaky`, {}, { service: 'test', ...fast });
    check('transient 5xx recovers via retry', flaky.ok && hits['/flaky'] === 3, `${hits['/flaky']} attempts`);

    const rate = await fetchJson<{ ok: boolean }>(`${base}/rate`, {}, { service: 'test', ...fast });
    check('429 + Retry-After honored then succeeds', rate.ok && hits['/rate'] === 2);

    let badErr: unknown = null;
    await fetchJson(`${base}/bad`, {}, { service: 'test', ...fast }).catch((e) => (badErr = e));
    check(
      'non-retryable 400 fails fast (single attempt, typed error)',
      badErr instanceof AdapterError && badErr.status === 400 && hits['/bad'] === 1,
    );

    let hangErr: unknown = null;
    await fetchWithRetry(`${base}/hang`, {}, { service: 'test', timeoutMs: 150, retries: 1, ...fast })
      .catch((e) => (hangErr = e));
    check(
      'hung endpoint hits per-attempt timeout, retries, then fails',
      hangErr instanceof AdapterError && hits['/hang'] === 2,
      `${hits['/hang'] ?? 0} attempts`,
    );

    const { listEvents } = await import('@storefront/db');
    const netEvents = listEvents(ctx.db).map((e) => e.type);
    check('adapter.retry events reach the audit log', netEvents.includes('adapter.retry'));
    check('adapter.error events reach the audit log', netEvents.includes('adapter.error'));
    const payloads = listEvents(ctx.db)
      .filter((e) => e.type.startsWith('adapter.'))
      .map((e) => e.payload_json ?? '');
    check('adapter event payloads never contain query strings (no secrets)', payloads.every((p) => !p.includes('?')));
  } finally {
    server.close();
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
