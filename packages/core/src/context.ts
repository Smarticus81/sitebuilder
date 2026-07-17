import { initDb, logEvent, type DB } from '@storefront/db';
import type { NetLogger } from '@storefront/net';
import { createPlacesProvider, type PlacesProvider } from '@storefront/places';
import { createLlmProvider, type LlmProvider } from '@storefront/llm';
import { createEmailProvider, type EmailProvider } from '@storefront/email';
import { createSmsProvider, type SmsProvider } from '@storefront/sms';
import { createPaymentsProvider, type PaymentsProvider } from '@storefront/payments';
import { createDeployProvider, type DeployProvider } from './deploy.js';
import { createAuditProvider, type AuditProvider } from './audit.js';
import { loadConfig, type StorefrontConfig } from './config.js';

/** Everything a pipeline stage needs, wired once. */
export interface Context {
  db: DB;
  places: PlacesProvider;
  llm: LlmProvider;
  email: EmailProvider;
  sms: SmsProvider;
  payments: PaymentsProvider;
  deploy: DeployProvider;
  audit: AuditProvider;
  config: StorefrontConfig;
}

let cached: Context | null = null;

export async function createContext(env: NodeJS.ProcessEnv = process.env): Promise<Context> {
  if (cached) return cached;
  const db = await initDb();
  const config = await loadConfig(db, env);
  // Adapter retries/failures land in the audit log alongside pipeline events.
  // Fire-and-forget: a log write must never fail a network call.
  const netLog: NetLogger = (type, payload) => {
    void logEvent(db, type, null, payload).catch(() => undefined);
  };
  cached = {
    db,
    config,
    places: createPlacesProvider(env, netLog),
    llm: createLlmProvider(env, netLog),
    email: createEmailProvider(env, netLog),
    sms: createSmsProvider(env, netLog),
    payments: createPaymentsProvider(env, netLog),
    deploy: createDeployProvider(env, netLog),
    audit: createAuditProvider(env, netLog),
  };
  return cached;
}

/** Which adapters are live vs mock — surfaced in the dashboard + CLI banner. */
export function adapterModes(ctx: Context): Record<string, 'live' | 'mock'> {
  return {
    places: ctx.places.mode,
    llm: ctx.llm.mode,
    email: ctx.email.mode,
    sms: ctx.sms.mode,
    payments: ctx.payments.mode,
    deploy: ctx.deploy.mode,
    audit: ctx.audit.mode,
  };
}
