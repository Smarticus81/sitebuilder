// Phase E — deliverability checks: SPF / DKIM / DMARC on the dedicated
// sending subdomain, plus the warm-up-aware daily cap ramp.

import { resolveTxt } from 'node:dns/promises';

export interface DnsCheck {
  ok: boolean;
  found: string | null;
  note: string;
}

export interface DeliverabilityReport {
  domain: string;
  spf: DnsCheck;
  dmarc: DnsCheck;
  dkim: DnsCheck;
}

/** Pure evaluators (unit-testable offline with fixture records). */
export function evaluateSpf(records: string[]): DnsCheck {
  const spf = records.find((r) => r.toLowerCase().startsWith('v=spf1'));
  if (!spf) return { ok: false, found: null, note: 'no v=spf1 TXT record on the sending domain' };
  if (!/[-~]all/.test(spf))
    return { ok: false, found: spf, note: 'SPF exists but does not end with ~all or -all' };
  return { ok: true, found: spf, note: 'SPF present with a restrictive all-mechanism' };
}

export function evaluateDmarc(records: string[]): DnsCheck {
  const rec = records.find((r) => r.toLowerCase().startsWith('v=dmarc1'));
  if (!rec) return { ok: false, found: null, note: 'no _dmarc TXT record' };
  const policy = /p=(none|quarantine|reject)/i.exec(rec)?.[1]?.toLowerCase();
  if (!policy) return { ok: false, found: rec, note: 'DMARC record has no p= policy' };
  return {
    ok: true,
    found: rec,
    note: policy === 'none' ? 'DMARC present (p=none — consider quarantine/reject once warmed)' : `DMARC p=${policy}`,
  };
}

export function evaluateDkim(records: string[]): DnsCheck {
  const rec = records.find((r) => /v=dkim1|k=rsa|p=[a-z0-9+/]/i.test(r));
  if (!rec) return { ok: false, found: null, note: 'no DKIM key found at the checked selectors' };
  return { ok: true, found: rec.slice(0, 60) + '…', note: 'DKIM key published' };
}

const flat = (txt: string[][]): string[] => txt.map((chunks) => chunks.join(''));

async function txtOf(name: string): Promise<string[]> {
  try {
    return flat(await resolveTxt(name));
  } catch {
    return [];
  }
}

/**
 * Live DNS check for a sending domain. DKIM selectors cover the common
 * provider defaults (Resend uses `resend._domainkey`).
 */
export async function checkDeliverabilityDns(
  domain: string,
  selectors: string[] = ['resend', 'default', 's1', 'google'],
): Promise<DeliverabilityReport> {
  const [spfRecords, dmarcRecords] = await Promise.all([txtOf(domain), txtOf(`_dmarc.${domain}`)]);
  let dkimRecords: string[] = [];
  for (const sel of selectors) {
    dkimRecords = await txtOf(`${sel}._domainkey.${domain}`);
    if (dkimRecords.length) break;
  }
  return {
    domain,
    spf: evaluateSpf(spfRecords),
    dmarc: evaluateDmarc(dmarcRecords),
    dkim: evaluateDkim(dkimRecords),
  };
}

// ── Warm-up-aware daily cap ───────────────────────────────────────────────────

/**
 * Effective daily send cap under a warm-up ramp. The ramp NEVER raises the
 * configured cap — it can only lower it while the sending domain warms up.
 *
 *   SEND_WARMUP_START=2026-07-01   (first sending day)
 *   SEND_WARMUP_RAMP=5,10,15,25   (weekly caps; last value holds thereafter)
 */
export function effectiveDailyCap(
  configuredCap: number,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): number {
  const start = env.SEND_WARMUP_START?.trim();
  const rampRaw = env.SEND_WARMUP_RAMP?.trim();
  if (!start || !rampRaw) return configuredCap;
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return configuredCap;
  const ramp = rampRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ramp.length) return configuredCap;

  const days = Math.floor((now.getTime() - startMs) / 86_400_000);
  if (days < 0) return Math.min(configuredCap, ramp[0]!); // before start: most conservative
  const week = Math.floor(days / 7);
  const rampCap = ramp[Math.min(week, ramp.length - 1)]!;
  return Math.min(configuredCap, rampCap);
}
