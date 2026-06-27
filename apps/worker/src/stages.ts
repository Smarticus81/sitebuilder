// Pipeline stages. Each reads rows in one status, processes, writes the next —
// making the whole pipeline resumable and inspectable.

import {
  upsertLead,
  listLeads,
  getLead,
  setLeadStatus,
  updateLead,
  logEvent,
  getMessage,
  type Lead,
} from '@storefront/db';
import {
  type Context,
  qualifyLead,
  buildDemo,
  draftOutreach,
  approveMessage,
  sendApprovedMessage,
  getMessageByLead,
  type SendOutcome,
} from '@storefront/core';

// ── Stage 1: Prospector ──────────────────────────────────────────────────────
export interface ProspectParams {
  category: string;
  location: string;
  limit?: number;
}

export async function prospect(ctx: Context, params: ProspectParams) {
  const places = await ctx.places.textSearch(params);
  let inserted = 0;
  let skipped = 0;
  for (const p of places) {
    if (p.businessStatus !== 'OPERATIONAL') {
      skipped++;
      continue;
    }
    const { inserted: isNew } = upsertLead(ctx.db, {
      place_id: p.placeId,
      name: p.name,
      category: p.category,
      address: p.address,
      phone: p.phone,
      lat: p.lat,
      lng: p.lng,
      website_url: p.website,
      rating: p.rating,
      review_count: p.reviewCount,
      places_json: JSON.stringify(p),
    });
    if (isNew) inserted++;
  }
  return { found: places.length, inserted, skipped };
}

// ── Stage 2: Qualifier ───────────────────────────────────────────────────────
export async function qualifyAll(ctx: Context) {
  const leads = listLeads(ctx.db, 'discovered');
  const out = { qualified: 0, dropped: 0, bad: 0, none: 0 };
  for (const lead of leads) {
    const r = await qualifyLead(lead, process.env);
    if (r.decision === 'drop') {
      updateLead(ctx.db, lead.id, { audit_json: JSON.stringify(r.audit), score: 0 });
      setLeadStatus(ctx.db, lead.id, 'lost', { audit_json: JSON.stringify(r.audit) });
      logEvent(ctx.db, 'lead.dropped', lead.id, { reason: r.reason });
      out.dropped++;
      continue;
    }
    updateLead(ctx.db, lead.id, {
      segment: r.segment,
      score: r.score,
      audit_json: r.audit ? JSON.stringify(r.audit) : null,
      contact_email: r.contactEmail,
    });
    setLeadStatus(ctx.db, lead.id, 'qualified');
    logEvent(ctx.db, 'lead.qualified', lead.id, {
      segment: r.segment,
      score: Number(r.score.toFixed(2)),
      reason: r.reason,
    });
    out.qualified++;
    if (r.segment === 'bad') out.bad++;
    else out.none++;
  }
  return out;
}

// ── Stage 3: Builder (Gate A → demo) ─────────────────────────────────────────
/**
 * Build demos for qualified leads. Phase 1 targets the `bad` segment (email-
 * reachable). `none`-segment leads are skipped here (phone-first, Phase 3).
 */
export async function buildAll(ctx: Context, opts: { limit?: number } = {}) {
  const leads = listLeads(ctx.db, 'qualified').filter((l) => l.segment === 'bad');
  const slice = opts.limit ? leads.slice(0, opts.limit) : leads;
  const built: number[] = [];
  for (const lead of slice) {
    await buildDemo(ctx, lead);
    built.push(lead.id);
  }
  return { built: built.length, leadIds: built, skippedNone: leads.length - slice.length };
}

export async function buildOne(ctx: Context, leadId: number) {
  const lead = requireLead(ctx, leadId);
  return buildDemo(ctx, lead);
}

// ── Stage 4: Outreach drafting (Gate B → draft) ──────────────────────────────
export async function draftAll(ctx: Context, opts: { limit?: number } = {}) {
  const leads = listLeads(ctx.db, 'demo_built');
  const slice = opts.limit ? leads.slice(0, opts.limit) : leads;
  const drafted: number[] = [];
  for (const lead of slice) {
    if (!lead.contact_email) continue; // email channel needs an address
    await draftOutreach(ctx, lead);
    setLeadStatus(ctx.db, lead.id, 'ready');
    drafted.push(lead.id);
  }
  return { drafted: drafted.length, leadIds: drafted };
}

export async function draftOne(ctx: Context, leadId: number) {
  const lead = requireLead(ctx, leadId);
  const msg = await draftOutreach(ctx, lead);
  setLeadStatus(ctx.db, lead.id, 'ready');
  return msg;
}

// ── Gate C: approve + send ───────────────────────────────────────────────────
export function approveLeadMessage(ctx: Context, leadId: number, approvedBy: string) {
  const msg = getMessageByLead(ctx.db, leadId);
  if (!msg) throw new Error(`No draft message for lead ${leadId}`);
  return approveMessage(ctx.db, msg.id, approvedBy);
}

export async function sendAll(
  ctx: Context,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<{ attempted: number; sent: number; blocked: number; outcomes: SendOutcome[] }> {
  // Only messages a human has APPROVED are eligible (Gate C).
  const approved = ctx.db
    .prepare(`SELECT * FROM messages WHERE status = 'approved' ORDER BY id ASC`)
    .all() as { id: number }[];
  const slice = opts.limit ? approved.slice(0, opts.limit) : approved;
  const outcomes: SendOutcome[] = [];
  let sent = 0;
  let blocked = 0;
  for (const m of slice) {
    const outcome = await sendApprovedMessage(ctx, m.id, { dryRun: opts.dryRun });
    outcomes.push(outcome);
    if (outcome.sent) sent++;
    else if (!outcome.gate.ok) blocked++;
  }
  return { attempted: slice.length, sent, blocked, outcomes };
}

export async function sendOneMessage(
  ctx: Context,
  messageId: number,
  opts: { dryRun?: boolean } = {},
) {
  if (!getMessage(ctx.db, messageId)) throw new Error(`Message ${messageId} not found`);
  return sendApprovedMessage(ctx, messageId, opts);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function requireLead(ctx: Context, id: number): Lead {
  const lead = getLead(ctx.db, id);
  if (!lead) throw new Error(`Lead ${id} not found`);
  return lead;
}
