import type { LighthouseScores, WebsiteAudit } from '@storefront/db';
import { fetchJson, type NetLogger } from '@storefront/net';

const CURRENT_YEAR = 2026; // pinned for deterministic staleness checks

// ── Lighthouse audit provider (adapter pattern, mock-first) ─────────────────

export interface AuditProvider {
  readonly mode: 'live' | 'mock';
  /** Full Lighthouse category scores for a URL, or null when unmeasurable. */
  lighthouse(url: string): Promise<LighthouseScores | null>;
}

// Canned Lighthouse results for the offline fixture hosts. Chosen so the
// qualifier's segmentation stays exactly as deterministic as before.
const MOCK_LIGHTHOUSE: Record<string, LighthouseScores> = {
  'clipjointfw.com': { performance: 41, seo: 55, accessibility: 61, bestPractices: 48 },
  'shearelegancefw.weebly.com': { performance: 34, seo: 62, accessibility: 58, bestPractices: 52 },
  'maneattractionfortworth.com': { performance: 52, seo: 49, accessibility: 66, bestPractices: 45 },
  'latherandfadefw.com': { performance: 47, seo: 51, accessibility: 60, bestPractices: 50 },
  'bombshellbeautyfw.com': { performance: 44, seo: 46, accessibility: 55, bestPractices: 41 },
  'polishedmodern.com': { performance: 92, seo: 96, accessibility: 94, bestPractices: 98 },
};

export class MockAuditProvider implements AuditProvider {
  readonly mode = 'mock' as const;
  async lighthouse(url: string): Promise<LighthouseScores | null> {
    return MOCK_LIGHTHOUSE[host(url)] ?? null;
  }
}

/**
 * Live impl: PageSpeed Insights, which runs full Lighthouse server-side. One
 * call returns all four categories.
 */
export class PageSpeedAuditProvider implements AuditProvider {
  readonly mode = 'live' as const;
  constructor(
    private readonly apiKey: string,
    private readonly log?: NetLogger,
  ) {}

  async lighthouse(url: string): Promise<LighthouseScores | null> {
    const endpoint =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
      `?url=${encodeURIComponent(url)}&strategy=mobile` +
      `&category=PERFORMANCE&category=SEO&category=ACCESSIBILITY&category=BEST_PRACTICES` +
      `&key=${this.apiKey}`;
    try {
      const data = await fetchJson<{
        lighthouseResult?: {
          categories?: Record<string, { score?: number } | undefined>;
        };
      }>(endpoint, {}, { service: 'audit', timeoutMs: 60_000, log: this.log });
      const cats = data.lighthouseResult?.categories ?? {};
      const pct = (c?: { score?: number }): number | null =>
        typeof c?.score === 'number' ? Math.round(c.score * 100) : null;
      return {
        performance: pct(cats['performance']),
        seo: pct(cats['seo']),
        accessibility: pct(cats['accessibility']),
        bestPractices: pct(cats['best-practices']),
      };
    } catch {
      // An unmeasurable site is a signal gap, not a pipeline failure.
      return null;
    }
  }
}

export function createAuditProvider(
  env: NodeJS.ProcessEnv = process.env,
  log?: NetLogger,
): AuditProvider {
  const key = env.PAGESPEED_API_KEY?.trim();
  return key ? new PageSpeedAuditProvider(key, log) : new MockAuditProvider();
}

// ── Website audit (heuristics + Lighthouse) ─────────────────────────────────

// Canned page-level signals for the offline fixture hosts, so the qualifier
// produces a stable segmentation with no network. Real hosts fall through to
// live checks.
const MOCK_AUDITS: Record<string, WebsiteAudit> = {
  'clipjointfw.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    lighthouse: MOCK_LIGHTHOUSE['clipjointfw.com']!,
    copyrightYear: 2016,
    notes: ['Served over plain HTTP', 'No mobile viewport meta tag', 'Footer says © 2016'],
  }),
  'shearelegancefw.weebly.com': verdict({
    reachable: true,
    https: true,
    mobileViewport: true,
    lighthouse: MOCK_LIGHTHOUSE['shearelegancefw.weebly.com']!,
    copyrightYear: 2018,
    notes: ['Hosted on an outdated Weebly template', 'Very slow on mobile (PageSpeed 34)'],
  }),
  'maneattractionfortworth.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    lighthouse: MOCK_LIGHTHOUSE['maneattractionfortworth.com']!,
    copyrightYear: 2017,
    notes: ['No HTTPS', 'Copyright stuck at 2017', 'Not mobile-friendly'],
  }),
  'latherandfadefw.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    lighthouse: MOCK_LIGHTHOUSE['latherandfadefw.com']!,
    copyrightYear: 2019,
    notes: ['No HTTPS', 'Not mobile-friendly', 'Slow to load on phones'],
  }),
  'bombshellbeautyfw.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    lighthouse: MOCK_LIGHTHOUSE['bombshellbeautyfw.com']!,
    copyrightYear: 2015,
    notes: ['Copyright says 2015', 'No HTTPS', 'No mobile viewport'],
  }),
  'polishedmodern.com': verdict({
    reachable: true,
    https: true,
    mobileViewport: true,
    lighthouse: MOCK_LIGHTHOUSE['polishedmodern.com']!,
    copyrightYear: 2026,
    notes: ['Modern, fast, mobile-friendly site already in place'],
  }),
};

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Fill verdict + stale + performanceScore from the raw signals. */
function verdict(
  a: Omit<WebsiteAudit, 'verdict' | 'stale' | 'performanceScore'>,
): WebsiteAudit {
  const performanceScore = a.lighthouse?.performance ?? null;
  const stale = a.copyrightYear != null && CURRENT_YEAR - a.copyrightYear >= 3;
  const poor =
    !a.reachable ||
    !a.https ||
    !a.mobileViewport ||
    (performanceScore != null && performanceScore < 55) ||
    stale;
  const good =
    a.reachable &&
    a.https &&
    a.mobileViewport &&
    !stale &&
    (performanceScore == null || performanceScore >= 80);
  return { ...a, performanceScore, stale, verdict: poor ? 'poor' : good ? 'good' : 'ok' };
}

/**
 * Audit a prospect's existing website. Mock-first: known fixture hosts return
 * canned results; otherwise we fetch the page (HTTPS / viewport / copyright)
 * and fold in full Lighthouse scores from the audit provider.
 */
export async function auditWebsite(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  provider: AuditProvider = createAuditProvider(env),
): Promise<WebsiteAudit> {
  const mock = MOCK_AUDITS[host(url)];
  if (mock) return mock;

  // Live path.
  let reachable = false;
  let html = '';
  let finalUrl = url;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    reachable = res.ok;
    finalUrl = res.url || url;
    html = await res.text();
  } catch {
    return verdict({
      reachable: false,
      https: url.startsWith('https://'),
      mobileViewport: false,
      lighthouse: null,
      copyrightYear: null,
      notes: ['Site did not load'],
    });
  }

  const https = finalUrl.startsWith('https://');
  const mobileViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const yearMatch = html.match(/(?:©|&copy;|copyright)\s*(\d{4})/i);
  const copyrightYear = yearMatch?.[1] ? Number(yearMatch[1]) : null;
  const lighthouse = await provider.lighthouse(finalUrl);

  const notes: string[] = [];
  if (!https) notes.push('No HTTPS');
  if (!mobileViewport) notes.push('No mobile viewport meta tag');
  if (copyrightYear && CURRENT_YEAR - copyrightYear >= 3)
    notes.push(`Copyright year is ${copyrightYear}`);
  if (lighthouse?.performance != null && lighthouse.performance < 55)
    notes.push(`Low Lighthouse performance (${lighthouse.performance})`);
  if (lighthouse?.seo != null && lighthouse.seo < 60)
    notes.push(`Weak SEO signals (Lighthouse SEO ${lighthouse.seo})`);
  if (lighthouse?.accessibility != null && lighthouse.accessibility < 60)
    notes.push(`Accessibility issues (Lighthouse a11y ${lighthouse.accessibility})`);

  return verdict({
    reachable,
    https,
    mobileViewport,
    lighthouse,
    copyrightYear,
    notes: notes.length ? notes : ['No obvious issues found'],
  });
}
