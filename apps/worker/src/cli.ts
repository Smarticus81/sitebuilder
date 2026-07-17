import './env.js';
import { getDb, migrate, resetDb, listLeads, listEvents, listSuppression } from '@storefront/db';
import { createContext, adapterModes } from '@storefront/core';
import {
  prospect,
  qualifyAll,
  buildAll,
  draftAll,
  approveLeadMessage,
  sendAll,
  draftSequenceForLead,
  approveSequenceById,
  runSequencesJob,
} from './stages.js';

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function banner() {
  const ctx = await createContext();
  const modes = adapterModes(ctx);
  const tags = Object.entries(modes)
    .map(([k, v]) => `${k}:${v.toUpperCase()}`)
    .join('  ');
  console.log(`\n  Storefront · adapters → ${tags}\n`);
  return ctx;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case 'migrate': {
      await migrate(getDb());
      console.log('✓ migrated');
      break;
    }
    case 'reset': {
      await migrate(getDb());
      await resetDb(getDb());
      console.log('✓ database reset');
      break;
    }
    case 'prospect': {
      const ctx = await banner();
      const category = String(flags.category ?? 'hair salon');
      const location = String(flags.location ?? 'Fort Worth, TX');
      const limit = flags.limit ? Number(flags.limit) : undefined;
      console.log(`Prospecting: "${category}" in "${location}"…`);
      const r = await prospect(ctx, { category, location, limit });
      console.log(`✓ found ${r.found}, inserted ${r.inserted} new, skipped ${r.skipped} (non-operational)`);
      break;
    }
    case 'qualify': {
      const ctx = await banner();
      const r = await qualifyAll(ctx);
      console.log(`✓ qualified ${r.qualified} (bad:${r.bad} none:${r.none}), dropped ${r.dropped}`);
      console.log('  → GATE A: review qualified leads in the dashboard before building.');
      break;
    }
    case 'build': {
      const ctx = await banner();
      const limit = flags.limit ? Number(flags.limit) : undefined;
      const r = await buildAll(ctx, { limit });
      console.log(`✓ built ${r.built} demo(s). Lead ids: ${r.leadIds.join(', ') || '—'}`);
      console.log('  → GATE B: preview each demo in the dashboard before drafting outreach.');
      break;
    }
    case 'draft': {
      const ctx = await banner();
      const limit = flags.limit ? Number(flags.limit) : undefined;
      const r = await draftAll(ctx, { limit });
      console.log(`✓ drafted ${r.drafted} outreach email(s). Lead ids: ${r.leadIds.join(', ') || '—'}`);
      console.log('  → GATE C: approve each draft, then `send`. Nothing sends without approval.');
      break;
    }
    case 'approve': {
      const ctx = await banner();
      const who = String(flags.by ?? 'cli-operator');
      const target = positional[0];
      if (!target) return fail('usage: approve <leadId|all> [--by name]');
      const ids =
        target === 'all'
          ? (await listLeads(ctx.db, 'ready')).map((l) => l.id)
          : [Number(target)];
      let n = 0;
      for (const id of ids) {
        try {
          await approveLeadMessage(ctx, id, who);
          n++;
        } catch (e) {
          console.warn(`  ! lead ${id}: ${(e as Error).message}`);
        }
      }
      console.log(`✓ approved ${n} message(s) (Gate C cleared, still capped + suppression-checked at send)`);
      break;
    }
    case 'send': {
      const ctx = await banner();
      const dryRun = flags['dry-run'] === true || flags.dry === true;
      const limit = flags.limit ? Number(flags.limit) : undefined;
      const r = await sendAll(ctx, { dryRun, limit });
      console.log(
        `${dryRun ? '[DRY RUN] ' : ''}attempted ${r.attempted}, sent ${r.sent}, blocked ${r.blocked}`,
      );
      for (const o of r.outcomes) {
        if (!o.gate.ok) console.log(`  ✗ blocked: ${o.gate.reasons.join('; ')}`);
        else if (o.dryRun) console.log(`  ◦ would send (${o.gate.sentToday}/${o.gate.cap} today)`);
        else if (o.sent) console.log(`  ✓ sent (${o.providerId})`);
        else if (o.error) console.log(`  ! error: ${o.error}`);
      }
      break;
    }
    case 'sequence': {
      const ctx = await banner();
      const sub = positional[0];
      if (sub === 'draft') {
        const leadId = Number(positional[1]);
        if (!leadId) return fail('usage: sequence draft <leadId>');
        const r = await draftSequenceForLead(ctx, leadId);
        console.log(
          `✓ drafted sequence ${r.sequence.id} for lead ${leadId} ` +
            `(${r.messages.length} follow-ups, ≥${r.sequence.spacing_days}d apart)`,
        );
        console.log('  → GATE: approve with `sequence approve <sequenceId>` before anything can send.');
      } else if (sub === 'approve') {
        const seqId = Number(positional[1]);
        if (!seqId) return fail('usage: sequence approve <sequenceId> [--by name]');
        const who = String(flags.by ?? 'cli-operator');
        const seq = await approveSequenceById(ctx, seqId, who);
        console.log(`✓ sequence ${seq.id} approved by ${who} (sends still gate-checked + spaced)`);
      } else if (sub === 'run') {
        const dryRun = flags['dry-run'] === true || flags.dry === true;
        const r = await runSequencesJob(ctx, { dryRun });
        console.log(
          `${dryRun ? '[DRY RUN] ' : ''}sequences: examined ${r.examined}, sent ${r.sent}, ` +
            `not-due ${r.skippedNotDue}, canceled ${r.canceled}, completed ${r.completed}`,
        );
      } else {
        return fail('usage: sequence draft <leadId> | sequence approve <sequenceId> | sequence run [--dry-run]');
      }
      break;
    }
    case 'callscript': {
      const ctx = await banner();
      const leadId = Number(positional[0]);
      if (!leadId) return fail('usage: callscript <leadId>');
      const { draftCallScript } = await import('@storefront/core');
      const { getLead } = await import('@storefront/db');
      const lead = await getLead(ctx.db, leadId);
      if (!lead) return fail(`lead ${leadId} not found`);
      const msg = await draftCallScript(ctx.db, ctx.config, lead);
      console.log(`✓ call script drafted (message ${msg.id}):\n`);
      console.log(msg.body);
      break;
    }
    case 'sms': {
      const ctx = await banner();
      const sub = positional[0];
      const { draftDemoSms, approveSms, sendApprovedSms } = await import('@storefront/core');
      const { getLead, getSms } = await import('@storefront/db');
      if (sub === 'draft') {
        const leadId = Number(positional[1]);
        if (!leadId) return fail('usage: sms draft <leadId>');
        const lead = await getLead(ctx.db, leadId);
        if (!lead) return fail(`lead ${leadId} not found`);
        const sms = await draftDemoSms(ctx.db, ctx.config, lead);
        console.log(`✓ SMS ${sms.id} drafted to ${sms.to_phone}:\n  ${sms.body}`);
        console.log('  → GATE: approve with `sms approve <smsId> --basis "<documented consent>"`');
      } else if (sub === 'approve') {
        const smsId = Number(positional[1]);
        const basis = String(flags.basis ?? '');
        if (!smsId) return fail('usage: sms approve <smsId> --basis "<documented opt-in / prior relationship>"');
        const sms = await approveSms(ctx.db, smsId, String(flags.by ?? 'cli-operator'), basis);
        console.log(`✓ SMS ${sms.id} approved (TCPA basis recorded). Still capped + opt-out-checked at send.`);
      } else if (sub === 'send') {
        const smsId = Number(positional[1]);
        if (!smsId) return fail('usage: sms send <smsId> [--dry-run]');
        if (!(await getSms(ctx.db, smsId))) return fail(`sms ${smsId} not found`);
        const dryRun = flags['dry-run'] === true || flags.dry === true;
        const out = await sendApprovedSms(ctx, smsId, { dryRun });
        if (!out.gate.ok) console.log(`✗ blocked: ${out.gate.reasons.join('; ')}`);
        else if (out.dryRun) console.log(`◦ would send (${out.gate.sentToday}/${out.gate.cap} today)`);
        else if (out.sent) console.log(`✓ sent (${out.providerId})`);
        else console.log(`! error: ${out.error}`);
      } else {
        return fail('usage: sms draft <leadId> | sms approve <smsId> --basis "..." | sms send <smsId> [--dry-run]');
      }
      break;
    }
    case 'proposal': {
      const ctx = await banner();
      const leadId = Number(positional[0]);
      if (!leadId) return fail('usage: proposal <leadId>');
      const { createProposal } = await import('@storefront/core');
      const { getLead } = await import('@storefront/db');
      const lead = await getLead(ctx.db, leadId);
      if (!lead) return fail(`lead ${leadId} not found`);
      const p = await createProposal(ctx, lead);
      console.log(`✓ proposal ${p.id} created:\n  page: ${p.url}\n  payment link: ${p.payment_link_url}`);
      break;
    }
    case 'domain-request': {
      const ctx = await banner();
      const leadId = Number(positional[0]);
      const domain = positional[1];
      if (!leadId || !domain) return fail('usage: domain-request <leadId> <domain>');
      const { requestDomainPurchase } = await import('@storefront/core');
      const { getLead } = await import('@storefront/db');
      const lead = await getLead(ctx.db, leadId);
      if (!lead) return fail(`lead ${leadId} not found`);
      const r = await requestDomainPurchase(ctx.db, lead, domain, String(flags.by ?? 'cli-operator'));
      console.log(`✓ domain request ${r.request.id} for ${r.request.domain} (NO purchase made)`);
      console.log(`  approve: ${r.approveUrl}`);
      console.log(`  decline: ${r.declineUrl}`);
      break;
    }
    case 'close': {
      const ctx = await banner();
      const leadId = Number(positional[0]);
      const outcome = positional[1] as 'won' | 'lost';
      const reason = String(flags.reason ?? '');
      if (!leadId || (outcome !== 'won' && outcome !== 'lost'))
        return fail('usage: close <leadId> won|lost --reason "..."');
      const { closeLead } = await import('@storefront/core');
      const lead = await closeLead(ctx.db, leadId, outcome, reason);
      console.log(`✓ lead ${lead.id} closed ${outcome}: ${lead.close_reason}`);
      break;
    }
    case 'unpublish': {
      const ctx = await banner();
      const { runUnpublishJob } = await import('@storefront/core');
      const r = await runUnpublishJob(ctx);
      console.log(`✓ unpublish job: examined ${r.examined}, unpublished ${r.unpublished}, failed ${r.failed}`);
      break;
    }
    case 'status': {
      const ctx = await banner();
      const leads = await listLeads(ctx.db);
      const byStatus: Record<string, number> = {};
      for (const l of leads) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
      console.log('Leads by status:');
      for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s.padEnd(12)} ${n}`);
      console.log(`\nSuppressed: ${(await listSuppression(ctx.db)).length}`);
      const events = await listEvents(ctx.db);
      console.log(`Recent events: ${events.length} (showing last 8)`);
      for (const e of events.slice(0, 8)) {
        console.log(`  ${e.created_at}  ${e.type}  lead=${e.lead_id ?? '—'}`);
      }
      break;
    }
    default:
      fail(
        `Unknown command: ${cmd ?? '(none)'}\n` +
          'Commands: migrate | reset | prospect | qualify | build | draft | approve | send | sequence | callscript | sms | proposal | domain-request | close | unpublish | status',
      );
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
