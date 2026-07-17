// Hardened HTTP for every live adapter: retry with exponential backoff + full
// jitter, per-attempt timeout, 429/Retry-After handling, and structured logging
// via an injectable sink (the worker wires it to the `events` audit table).
// Mock adapters never touch this module, so offline runs stay deterministic.

/** Structured log sink. Payloads MUST never contain secrets — see redactUrl. */
export type NetLogger = (type: string, payload: Record<string, unknown>) => void;

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly service: string,
    readonly status: number | null,
    readonly attempts: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface RetryOptions {
  /** Adapter name for logs, e.g. "places", "llm", "email", "deploy". */
  service: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Number of RETRIES after the first attempt (total attempts = retries + 1). */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  log?: NetLogger;
  /**
   * Retrying non-idempotent requests (e.g. sending an email) can duplicate the
   * side effect. Set false unless the request carries an idempotency key.
   */
  retryable?: boolean;
}

const DEFAULTS = {
  timeoutMs: 20_000,
  retries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
} as const;

/** Strip query string + hash so API keys in URLs can never reach a log. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 529 || status >= 500;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, capped. */
function backoffMs(attempt: number, base: number, max: number): number {
  return Math.random() * Math.min(max, base * 2 ** attempt);
}

/**
 * fetch() with retries. Retries network failures, timeouts, and retryable HTTP
 * statuses (408/429/529/5xx), honoring Retry-After. Returns the last Response
 * for non-retryable statuses (callers decide how to fail); throws AdapterError
 * only when every attempt failed at the transport layer.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const cfg = { ...DEFAULTS, retryable: true, ...opts };
  const attempts = cfg.retryable ? cfg.retries + 1 : 1;
  const safeUrl = redactUrl(url);
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) });
    } catch (err) {
      lastErr = err;
    }

    if (res && !retryableStatus(res.status)) return res; // success OR non-retryable error
    if (attempt === attempts - 1) {
      if (res) return res; // exhausted retries on a retryable status
      break;
    }

    const status = res?.status ?? null;
    const wait = (res ? retryAfterMs(res) : null) ?? backoffMs(attempt, cfg.baseDelayMs, cfg.maxDelayMs);
    cfg.log?.('adapter.retry', {
      service: cfg.service,
      url: safeUrl,
      attempt: attempt + 1,
      status,
      error: res ? undefined : String(lastErr),
      wait_ms: Math.round(wait),
    });
    // drain the failed body so the socket is released
    if (res) await res.text().catch(() => undefined);
    await sleep(wait);
  }

  const err = new AdapterError(
    `${cfg.service}: request failed after ${attempts} attempt(s): ${String(lastErr)}`,
    cfg.service,
    null,
    attempts,
  );
  cfg.log?.('adapter.error', {
    service: cfg.service,
    url: safeUrl,
    attempts,
    error: String(lastErr),
  });
  throw err;
}

/**
 * fetchWithRetry + JSON parse. Throws AdapterError (and logs adapter.error) on
 * any non-2xx status, with a truncated body snippet for diagnosis.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<T> {
  const res = await fetchWithRetry(url, init, opts);
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    const err = new AdapterError(
      `${opts.service}: HTTP ${res.status} from ${redactUrl(url)}`,
      opts.service,
      res.status,
      1,
      body,
    );
    opts.log?.('adapter.error', {
      service: opts.service,
      url: redactUrl(url),
      status: res.status,
      body,
    });
    throw err;
  }
  return (await res.json()) as T;
}
