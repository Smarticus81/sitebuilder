import { getDb, logEvent, type DB } from '@storefront/db';
import type { NetLogger } from '@storefront/net';
import { createPlacesProvider, type PlacesProvider } from '@storefront/places';
import { createLlmProvider, type LlmProvider } from '@storefront/llm';
import { createEmailProvider, type EmailProvider } from '@storefront/email';
import { createDeployProvider, type DeployProvider } from './deploy.js';
import { loadConfig, type StorefrontConfig } from './config.js';

/** Everything a pipeline stage needs, wired once. */
export interface Context {
  db: DB;
  places: PlacesProvider;
  llm: LlmProvider;
  email: EmailProvider;
  deploy: DeployProvider;
  config: StorefrontConfig;
}

let cached: Context | null = null;

export function createContext(env: NodeJS.ProcessEnv = process.env): Context {
  if (cached) return cached;
  const db = getDb();
  const config = loadConfig(db, env);
  // Adapter retries/failures land in the audit log alongside pipeline events.
  const netLog: NetLogger = (type, payload) => logEvent(db, type, null, payload);
  cached = {
    db,
    config,
    places: createPlacesProvider(env, netLog),
    llm: createLlmProvider(env, netLog),
    email: createEmailProvider(env, netLog),
    deploy: createDeployProvider(env, netLog),
  };
  return cached;
}

/** Which adapters are live vs mock — surfaced in the dashboard + CLI banner. */
export function adapterModes(ctx: Context): Record<string, 'live' | 'mock'> {
  return {
    places: ctx.places.mode,
    llm: ctx.llm.mode,
    email: ctx.email.mode,
    deploy: ctx.deploy.mode,
  };
}
