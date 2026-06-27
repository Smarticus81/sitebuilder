import type { Lead, Segment, WebsiteAudit } from '@storefront/db';
import { auditWebsite } from './audit.js';
import { scrapeContactEmail } from './email-scrape.js';

export interface QualifyResult {
  decision: 'qualify' | 'drop';
  segment: Segment | null;
  score: number;
  audit: WebsiteAudit | null;
  contactEmail: string | null;
  reason: string;
}

// Scoring weights (spec §4.2): score = w1·noRealSite + w2·log(reviews+1)
//                                    + w3·rating + w4·emailFound
const W = { noRealSite: 3, reviews: 1.2, rating: 1.5, emailFound: 2 } as const;

const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'fb.com', 'linktr.ee', 'business.site'];

function isSocialOnly(url: string): boolean {
  try {
    const h = new URL(url).host.replace(/^www\./, '');
    return SOCIAL_HOSTS.some((s) => h === s || h.endsWith(`.${s}`) || h.includes(s));
  } catch {
    return false;
  }
}

function score(lead: Lead, noRealSite: boolean, emailFound: boolean): number {
  const reviews = Math.log((lead.review_count ?? 0) + 1);
  const rating = lead.rating ?? 0;
  return (
    W.noRealSite * (noRealSite ? 1 : 0) +
    W.reviews * reviews +
    W.rating * rating +
    W.emailFound * (emailFound ? 1 : 0)
  );
}

/**
 * Segment + score a discovered lead.
 *  • No website field            → segment 'none'
 *  • Facebook/Instagram-only     → segment 'none'
 *  • Has site, audit = good      → DROP (they don't need us)
 *  • Has site, audit = poor/ok   → segment 'bad'  (Phase 1 target)
 */
export async function qualifyLead(
  lead: Lead,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QualifyResult> {
  // No real website → 'none'. Still try to scrape an email if a social URL exists.
  if (!lead.website_url || isSocialOnly(lead.website_url)) {
    const noRealSite = true;
    const contactEmail = null; // 'none' segment is phone-first; email not expected
    return {
      decision: 'qualify',
      segment: 'none',
      score: score(lead, noRealSite, false),
      audit: null,
      contactEmail,
      reason: lead.website_url ? 'Social-media-only presence' : 'No website found',
    };
  }

  const audit = await auditWebsite(lead.website_url, env);
  if (audit.verdict === 'good') {
    return {
      decision: 'drop',
      segment: null,
      score: 0,
      audit,
      contactEmail: null,
      reason: 'Existing site is already modern and fast',
    };
  }

  const contactEmail = await scrapeContactEmail(lead.website_url);
  return {
    decision: 'qualify',
    segment: 'bad',
    score: score(lead, false, !!contactEmail),
    audit,
    contactEmail,
    reason: `Outdated site: ${audit.notes.slice(0, 2).join('; ')}`,
  };
}

/** A short human-readable observation about the current site, for outreach. */
export function siteObservation(audit: WebsiteAudit | null): string {
  if (!audit) return "you don't have a website yet";
  if (audit.notes.length) return `your current site ${audit.notes[0]!.toLowerCase()}`;
  return 'your current site could use a refresh';
}
