import type { WebsiteAudit } from '@storefront/db';

const CURRENT_YEAR = 2026; // pinned for deterministic staleness checks

// Canned audits for the offline fixture hosts, so the qualifier produces a
// stable segmentation with no network. Real hosts fall through to live checks.
const MOCK_AUDITS: Record<string, WebsiteAudit> = {
  'clipjointfw.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    performanceScore: 41,
    copyrightYear: 2016,
    notes: ['Served over plain HTTP', 'No mobile viewport meta tag', 'Footer says © 2016'],
  }),
  'shearelegancefw.weebly.com': verdict({
    reachable: true,
    https: true,
    mobileViewport: true,
    performanceScore: 34,
    copyrightYear: 2018,
    notes: ['Hosted on an outdated Weebly template', 'Very slow on mobile (PageSpeed 34)'],
  }),
  'maneattractionfortworth.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    performanceScore: 52,
    copyrightYear: 2017,
    notes: ['No HTTPS', 'Copyright stuck at 2017', 'Not mobile-friendly'],
  }),
  'latherandfadefw.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    performanceScore: 47,
    copyrightYear: 2019,
    notes: ['No HTTPS', 'Not mobile-friendly', 'Slow to load on phones'],
  }),
  'bombshellbeautyfw.com': verdict({
    reachable: true,
    https: false,
    mobileViewport: false,
    performanceScore: 44,
    copyrightYear: 2015,
    notes: ['Copyright says 2015', 'No HTTPS', 'No mobile viewport'],
  }),
  'polishedmodern.com': verdict({
    reachable: true,
    https: true,
    mobileViewport: true,
    performanceScore: 92,
    copyrightYear: new Date('2026-01-01').getUTCFullYear(),
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

/** Fill verdict + stale from the raw signals. */
function verdict(a: Omit<WebsiteAudit, 'verdict' | 'stale'>): WebsiteAudit {
  const stale = a.copyrightYear != null && CURRENT_YEAR - a.copyrightYear >= 3;
  const poor =
    !a.reachable ||
    !a.https ||
    !a.mobileViewport ||
    (a.performanceScore != null && a.performanceScore < 55) ||
    stale;
  const good =
    a.reachable &&
    a.https &&
    a.mobileViewport &&
    !stale &&
    (a.performanceScore == null || a.performanceScore >= 80);
  return { ...a, stale, verdict: poor ? 'poor' : good ? 'good' : 'ok' };
}

/**
 * Audit a prospect's existing website. Mock-first: known fixture hosts return
 * canned results; otherwise we fetch the page (HTTPS / viewport / copyright)
 * and, if PAGESPEED_API_KEY is set, fold in a real performance score.
 */
export async function auditWebsite(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
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
      performanceScore: null,
      copyrightYear: null,
      notes: ['Site did not load'],
    });
  }

  const https = finalUrl.startsWith('https://');
  const mobileViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const yearMatch = html.match(/(?:©|&copy;|copyright)\s*(\d{4})/i);
  const copyrightYear = yearMatch?.[1] ? Number(yearMatch[1]) : null;
  const performanceScore = await pageSpeed(finalUrl, env);

  const notes: string[] = [];
  if (!https) notes.push('No HTTPS');
  if (!mobileViewport) notes.push('No mobile viewport meta tag');
  if (copyrightYear && CURRENT_YEAR - copyrightYear >= 3)
    notes.push(`Copyright year is ${copyrightYear}`);
  if (performanceScore != null && performanceScore < 55)
    notes.push(`Low PageSpeed score (${performanceScore})`);

  return verdict({
    reachable,
    https,
    mobileViewport,
    performanceScore,
    copyrightYear,
    notes: notes.length ? notes : ['No obvious issues found'],
  });
}

/** PageSpeed Insights performance score 0–100, or null if unavailable. */
async function pageSpeed(
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  const key = env.PAGESPEED_API_KEY?.trim();
  if (!key) return null;
  try {
    const endpoint =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
      `?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${key}`;
    const res = await fetch(endpoint);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      lighthouseResult?: { categories?: { performance?: { score?: number } } };
    };
    const score = data.lighthouseResult?.categories?.performance?.score;
    return typeof score === 'number' ? Math.round(score * 100) : null;
  } catch {
    return null;
  }
}
