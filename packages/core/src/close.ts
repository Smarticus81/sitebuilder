// Phase 3 — close & convert. Proposals package the demo + pricing + a Stripe
// payment link (customer-initiated payment only). Domain purchases are
// REQUEST-ONLY: the system mints an approval link for the human; nothing here
// can buy a domain. Won/lost closes always record a reason.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getDomainRequestByToken,
  decideDomainRequest as decideDomainRequestDb,
  getLead,
  insertDomainRequest,
  insertProposal,
  logEvent,
  setLeadStatus,
  type DB,
  type DomainRequest,
  type Lead,
  type Proposal,
} from '@storefront/db';
import type { PaymentsProvider } from '@storefront/payments';
import type { StorefrontConfig } from './config.js';
import { publicBaseUrl } from './compliance.js';
import { slugify } from './slug.js';

export interface ProposalPricing {
  priceCents: number;
  monthlyCents: number | null;
  currency: string;
}

export function proposalPricing(env: NodeJS.ProcessEnv = process.env): ProposalPricing {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
  };
  return {
    priceCents: num(env.PROPOSAL_PRICE_CENTS, 150_000),
    monthlyCents: num(env.PROPOSAL_MONTHLY_CENTS, 5_000),
    currency: (env.PROPOSAL_CURRENCY ?? 'usd').toLowerCase(),
  };
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(
    cents / 100,
  );

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Create a proposal for a lead: payment link (via the payments adapter) + a
 * self-contained proposal page written to proposals-out/<slug>/ and served by
 * the worker at /proposals/<slug>/.
 */
export async function createProposal(
  deps: { db: DB; payments: PaymentsProvider; config: StorefrontConfig },
  lead: Lead,
  pricing: ProposalPricing = proposalPricing(),
): Promise<Proposal> {
  const { db, payments, config } = deps;
  if (!lead.demo_url) throw new Error(`Lead ${lead.id} has no demo — build it first (Gate A)`);

  const link = await payments.createPaymentLink({
    ref: `lead-${lead.id}`,
    description: `Website build for ${lead.name} — ${config.senderBusiness}`,
    amountCents: pricing.priceCents,
    currency: pricing.currency,
  });

  const slug = slugify(lead.name);
  const html = renderProposalPage(lead, config, pricing, link.url);
  const dir = resolve(process.cwd(), 'proposals-out', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'index.html'), html);
  const url = `${publicBaseUrl()}/proposals/${slug}/`;

  return await insertProposal(db, {
    lead_id: lead.id,
    slug,
    url,
    payment_link_url: link.url,
    payment_link_id: link.id,
    price_cents: pricing.priceCents,
    monthly_cents: pricing.monthlyCents,
    currency: pricing.currency,
  });
}

function renderProposalPage(
  lead: Lead,
  config: StorefrontConfig,
  pricing: ProposalPricing,
  paymentUrl: string,
): string {
  const oneTime = money(pricing.priceCents, pricing.currency);
  const monthly = pricing.monthlyCents ? money(pricing.monthlyCents, pricing.currency) : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Website proposal — ${esc(lead.name)}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Segoe UI',system-ui,sans-serif; color:#15151b; background:#f7f7f4; line-height:1.6; }
  .wrap { max-width:720px; margin:0 auto; padding:48px 20px; }
  h1 { font-size:34px; margin-bottom:6px; }
  .sub { color:#6b7280; margin-bottom:28px; }
  .card { background:#fff; border:1px solid #e7e4de; border-radius:14px; padding:26px; margin-bottom:18px; }
  .card h2 { font-size:20px; margin-bottom:10px; }
  ul { padding-left:20px; }
  li { margin:6px 0; }
  .price { font-size:30px; font-weight:800; }
  .btn { display:inline-block; margin-top:14px; padding:14px 26px; border-radius:999px;
         background:#0f766e; color:#fff; font-weight:700; text-decoration:none; }
  .demo-link { color:#0f766e; font-weight:600; }
  footer { color:#9aa3b2; font-size:13px; margin-top:26px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>A new website for ${esc(lead.name)}</h1>
    <p class="sub">Prepared by ${esc(config.senderName)}, ${esc(config.senderBusiness)}</p>

    <div class="card">
      <h2>Your live preview</h2>
      <p>The demo you saw is real and ready to become your site:</p>
      <p><a class="demo-link" href="${esc(lead.demo_url ?? '')}">${esc(lead.demo_url ?? '')}</a></p>
    </div>

    <div class="card">
      <h2>What's included</h2>
      <ul>
        <li>The full site you previewed, on your own domain</li>
        <li>Mobile-first, fast (90+ Lighthouse performance)</li>
        <li>Your real reviews, photos, hours and services</li>
        <li>Edits and tweaks until you're happy at launch</li>
      </ul>
    </div>

    <div class="card">
      <h2>Pricing</h2>
      <p class="price">${esc(oneTime)}</p>
      <p>one-time build${monthly ? ` · ${esc(monthly)}/mo optional care plan (hosting, edits, backups)` : ''}</p>
      <a class="btn" href="${esc(paymentUrl)}">Accept &amp; pay securely</a>
      <p style="margin-top:10px;color:#6b7280;font-size:14px">Payment is handled by Stripe. Nothing is charged until you choose to pay.</p>
    </div>

    <footer>
      ${esc(config.senderBusiness)} · ${esc(config.mailingAddress)}<br/>
      Questions? Reply to the email this proposal came from, or ${esc(config.replyTo)}.
    </footer>
  </div>
</body>
</html>`;
}

// ── Domain purchase REQUESTS (approval links only — never a purchase) ────────

export interface DomainRequestWithLink {
  request: DomainRequest;
  approveUrl: string;
  declineUrl: string;
}

export async function requestDomainPurchase(
  db: DB,
  lead: Lead,
  domain: string,
  requestedBy: string,
): Promise<DomainRequestWithLink> {
  const clean = domain.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) {
    throw new Error(`"${domain}" does not look like a valid domain name`);
  }
  const token = randomBytes(16).toString('hex');
  const request = await insertDomainRequest(db, {
    lead_id: lead.id,
    domain: clean,
    token,
    requested_by: requestedBy,
  });
  const base = publicBaseUrl();
  return {
    request,
    approveUrl: `${base}/approve/domain?token=${token}&decision=approve`,
    declineUrl: `${base}/approve/domain?token=${token}&decision=decline`,
  };
}

/** Record the HUMAN's decision. Approving records intent only — purchasing the
 *  domain remains a manual operator action outside this system. */
export async function decideDomainRequest(
  db: DB,
  token: string,
  decision: 'approved' | 'declined',
  decidedBy: string,
): Promise<DomainRequest> {
  const existing = await getDomainRequestByToken(db, token);
  if (!existing) throw new Error('Domain request not found');
  return decideDomainRequestDb(db, token, decision, decidedBy);
}

// ── Won / lost with reasons ───────────────────────────────────────────────────

export async function closeLead(
  db: DB,
  leadId: number,
  outcome: 'won' | 'lost',
  reason: string,
): Promise<Lead> {
  const lead = await getLead(db, leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (!reason.trim()) throw new Error('A close reason is required (won/lost must be explainable)');
  const updated = await setLeadStatus(db, leadId, outcome, {
    close_reason: reason.trim(),
    closed_at: new Date().toISOString(),
  });
  await logEvent(db, `lead.${outcome}`, leadId, { reason: reason.trim() });
  return updated;
}
