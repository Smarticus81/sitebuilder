// `pnpm smoke` — LIVE smoke suite. For every adapter that has a real key it
// performs one minimal real operation and asserts the response shape. Adapters
// without keys are SKIPPED (exit stays 0), so this is safe to run anywhere.
//
// Compliance notes:
//  • email: auth-only check. Mail can ONLY leave via checkSendGate() — the
//    smoke suite never sends.
//  • deploy: creates one tiny throwaway deployment, then unpublishes it.
//  • No DB writes, no pipeline mutations.

import './env.js';
import { createPlacesProvider } from '@storefront/places';
import { createLlmProvider } from '@storefront/llm';
import { createDeployProvider, createAuditProvider } from '@storefront/core';
import { fetchWithRetry } from '@storefront/net';

type Outcome = 'pass' | 'fail' | 'skip';
const results: { name: string; outcome: Outcome; note: string }[] = [];

function record(name: string, outcome: Outcome, note = '') {
  results.push({ name, outcome, note });
  const mark = outcome === 'pass' ? '✓' : outcome === 'skip' ? '◦' : '✗';
  console.log(`  ${mark} ${name.padEnd(8)} ${outcome.toUpperCase()}  ${note}`);
}

async function smoke(name: string, hasKey: boolean, run: () => Promise<string>) {
  if (!hasKey) {
    record(name, 'skip', 'no key configured');
    return;
  }
  try {
    record(name, 'pass', await run());
  } catch (err) {
    record(name, 'fail', String(err).slice(0, 160));
  }
}

async function main() {
  const env = process.env;
  console.log('\nStorefront live smoke suite (keyed adapters only)\n');

  await smoke('places', !!env.GOOGLE_PLACES_API_KEY?.trim(), async () => {
    const places = createPlacesProvider(env);
    const res = await places.textSearch({ category: 'coffee shop', location: 'Fort Worth, TX', limit: 3 });
    if (!res.length || !res[0]!.placeId || !res[0]!.name) throw new Error('empty/malformed searchText response');
    return `${res.length} places, first: ${res[0]!.name}`;
  });

  await smoke('llm', !!env.ANTHROPIC_API_KEY?.trim(), async () => {
    const llm = createLlmProvider(env);
    const copy = await llm.demoCopy({
      name: 'Smoke Test Barbers',
      category: 'barber_shop',
      city: 'Fort Worth',
      reviews: ['Great fades, friendly staff.'],
    });
    if (!copy.tagline || !copy.about || !Array.isArray(copy.services)) throw new Error('malformed demoCopy JSON');
    return `tagline: "${copy.tagline.slice(0, 60)}"`;
  });

  await smoke('audit', !!env.PAGESPEED_API_KEY?.trim(), async () => {
    const audit = createAuditProvider(env);
    const lh = await audit.lighthouse('https://example.com');
    if (!lh || lh.performance == null) throw new Error('no Lighthouse scores returned');
    return `example.com → perf ${lh.performance}, seo ${lh.seo}, a11y ${lh.accessibility}, bp ${lh.bestPractices}`;
  });

  await smoke('deploy', !!env.VERCEL_TOKEN?.trim(), async () => {
    const deploy = createDeployProvider(env);
    const html = '<!doctype html><title>storefront smoke</title><p>ok</p>';
    const base = env.DEMO_BASE_DOMAIN ?? 'demo.example.com';
    const r = await deploy.deploy({ slug: 'smoke-test', subdomain: `smoke-test.${base}`, html });
    if (!r.url) throw new Error('deploy returned no URL');
    await deploy.unpublish('smoke-test');
    return `deployed ${r.url} then unpublished`;
  });

  await smoke(
    'email',
    (env.EMAIL_PROVIDER ?? 'mock') === 'resend' && !!env.EMAIL_PROVIDER_API_KEY?.trim(),
    async () => {
      // Auth-only: sending is exclusively checkSendGate()'s job.
      const res = await fetchWithRetry(
        'https://api.resend.com/domains',
        { headers: { Authorization: `Bearer ${env.EMAIL_PROVIDER_API_KEY}` } },
        { service: 'smoke', retries: 1 },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data?: { name: string }[] };
      return `authenticated; ${data.data?.length ?? 0} domain(s) registered (no mail sent)`;
    },
  );

  const failed = results.filter((r) => r.outcome === 'fail').length;
  const passed = results.filter((r) => r.outcome === 'pass').length;
  const skipped = results.filter((r) => r.outcome === 'skip').length;
  console.log(`\n${failed === 0 ? '✅' : '❌'} smoke: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
