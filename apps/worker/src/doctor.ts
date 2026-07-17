// `pnpm doctor` — validates .env, reports mock/live per adapter, and pings
// every LIVE adapter with the cheapest possible real call. Never sends mail,
// never creates deployments, never writes pipeline data.

import './env.js';
import { fetchWithRetry, redactUrl } from '@storefront/net';
import { createContext, adapterModes, validateEnv } from '@storefront/core';

type PingResult = { ok: boolean; note: string };

const env = process.env;
const PING: Record<string, () => Promise<PingResult>> = {
  places: async () => {
    const res = await fetchWithRetry(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY!,
          'X-Goog-FieldMask': 'places.id',
        },
        body: JSON.stringify({ textQuery: 'coffee in Fort Worth, TX', pageSize: 1 }),
      },
      { service: 'doctor', retries: 1 },
    );
    return { ok: res.ok, note: res.ok ? 'searchText responded' : `HTTP ${res.status}` };
  },

  llm: async () => {
    const res = await fetchWithRetry(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
      { service: 'doctor', retries: 1, timeoutMs: 30_000 },
    );
    return { ok: res.ok, note: res.ok ? 'messages API responded' : `HTTP ${res.status}` };
  },

  email: async () => {
    // Auth check only — NEVER a send. Also verifies FROM_DOMAIN is registered.
    const res = await fetchWithRetry(
      'https://api.resend.com/domains',
      { headers: { Authorization: `Bearer ${env.EMAIL_PROVIDER_API_KEY}` } },
      { service: 'doctor', retries: 1 },
    );
    if (!res.ok) return { ok: false, note: `HTTP ${res.status}` };
    const data = (await res.json()) as { data?: { name: string; status: string }[] };
    const domains = data.data ?? [];
    const from = env.FROM_DOMAIN?.trim();
    const match = domains.find((d) => d.name === from);
    if (!match)
      return {
        ok: false,
        note: `authenticated, but FROM_DOMAIN "${from}" is not registered in Resend (${domains.length} domain(s) found)`,
      };
    if (match.status !== 'verified')
      return { ok: false, note: `FROM_DOMAIN "${from}" is registered but status is "${match.status}" (needs DNS verification)` };
    return { ok: true, note: `FROM_DOMAIN "${from}" verified in Resend` };
  },

  sms: async () => {
    const sid = env.TWILIO_ACCOUNT_SID!;
    const res = await fetchWithRetry(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
        },
      },
      { service: 'doctor', retries: 1 },
    );
    return { ok: res.ok, note: res.ok ? 'Twilio account authenticated' : `HTTP ${res.status}` };
  },

  deploy: async () => {
    const url = new URL('https://api.vercel.com/v2/user');
    if (env.VERCEL_TEAM_ID) url.searchParams.set('teamId', env.VERCEL_TEAM_ID);
    const res = await fetchWithRetry(
      url.toString(),
      { headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` } },
      { service: 'doctor', retries: 1 },
    );
    return { ok: res.ok, note: res.ok ? 'token authenticated' : `HTTP ${res.status}` };
  },

  payments: async () => {
    const res = await fetchWithRetry(
      'https://api.stripe.com/v1/balance',
      { headers: { Authorization: `Bearer ${env.STRIPE_API_KEY}` } },
      { service: 'doctor', retries: 1 },
    );
    return { ok: res.ok, note: res.ok ? 'Stripe key authenticated (read-only balance check)' : `HTTP ${res.status}` };
  },

  audit: async () => {
    const url =
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
      `?url=${encodeURIComponent('https://example.com')}&strategy=mobile&category=PERFORMANCE&key=${env.PAGESPEED_API_KEY}`;
    const res = await fetchWithRetry(url, {}, { service: 'doctor', retries: 1, timeoutMs: 60_000 });
    return { ok: res.ok, note: res.ok ? 'Lighthouse run completed' : `HTTP ${res.status} from ${redactUrl(url)}` };
  },
};

async function main() {
  console.log('\nStorefront doctor\n');
  let failures = 0;

  // 1. Environment validation.
  const report = validateEnv(env);
  console.log('── Environment ──────────────────────────────────────────────');
  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log('  ✓ env looks good');
  }
  for (const e of report.errors) {
    console.log(`  ✗ ${e}`);
    failures++;
  }
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);

  // 2. Adapter modes + live pings.
  const ctx = await createContext();
  const modes = adapterModes(ctx);
  console.log('\n── Adapters ─────────────────────────────────────────────────');
  for (const [name, mode] of Object.entries(modes)) {
    if (mode === 'mock') {
      console.log(`  ◦ ${name.padEnd(7)} MOCK  (no key configured — deterministic offline mode)`);
      continue;
    }
    process.stdout.write(`  … ${name.padEnd(7)} LIVE  pinging`);
    try {
      const r = await PING[name]!();
      console.log(`\r  ${r.ok ? '✓' : '✗'} ${name.padEnd(7)} LIVE  ${r.note}          `);
      if (!r.ok) failures++;
    } catch (err) {
      console.log(`\r  ✗ ${name.padEnd(7)} LIVE  ping failed: ${String(err).slice(0, 120)}`);
      failures++;
    }
  }

  // 3. Database.
  console.log('\n── Database ─────────────────────────────────────────────────');
  try {
    await ctx.db.get('SELECT 1');
    console.log(`  ✓ ${env.DATABASE_URL ?? 'sqlite:./data/storefront.db'} reachable (${ctx.db.dialect})`);
  } catch (err) {
    console.log(`  ✗ database error: ${String(err)}`);
    failures++;
  }

  console.log(
    failures === 0
      ? '\n✅ doctor: all checks passed\n'
      : `\n❌ doctor: ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
