import { getDb, type DB } from '@storefront/db';
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
  cached = {
    db,
    config,
    places: createPlacesProvider(env),
    llm: createLlmProvider(env),
    email: createEmailProvider(env),
    deploy: createDeployProvider(env),
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
