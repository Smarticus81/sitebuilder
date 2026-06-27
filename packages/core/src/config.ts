import { getConfigRow, upsertConfig, type DB } from '@storefront/db';

/** Resolved sender identity + pipeline policy. */
export interface StorefrontConfig {
  senderName: string;
  senderBusiness: string;
  mailingAddress: string;
  replyTo: string;
  fromDomain: string;
  dailySendCap: number;
  followupDays: number;
  demoTtlDays: number;
  demoBaseDomain: string;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
};

/**
 * Load config from env, persisting it into the DB `config` row so the dashboard
 * and audit log have a stable source of truth. Env always wins on (re)load.
 */
export function loadConfig(db: DB, env: NodeJS.ProcessEnv = process.env): StorefrontConfig {
  const cfg: StorefrontConfig = {
    senderName: env.SENDER_NAME ?? 'Unknown Sender',
    senderBusiness: env.SENDER_BUSINESS ?? 'Storefront Web Studio',
    mailingAddress: env.MAILING_ADDRESS ?? '',
    replyTo: env.REPLY_TO ?? '',
    fromDomain: env.FROM_DOMAIN ?? 'outreach.example.com',
    dailySendCap: num(env.DAILY_SEND_CAP, 15),
    followupDays: num(env.FOLLOWUP_DAYS, 4),
    demoTtlDays: num(env.DEMO_TTL_DAYS, 14),
    demoBaseDomain: env.DEMO_BASE_DOMAIN ?? 'demo.example.com',
  };
  upsertConfig(db, {
    sender_name: cfg.senderName,
    sender_business: cfg.senderBusiness,
    mailing_address: cfg.mailingAddress,
    reply_to: cfg.replyTo,
    from_domain: cfg.fromDomain,
    daily_send_cap: cfg.dailySendCap,
    followup_days: cfg.followupDays,
    demo_ttl_days: cfg.demoTtlDays,
  });
  return cfg;
}

/** Read persisted config back out of the DB (used by the API server). */
export function readConfig(db: DB): StorefrontConfig | null {
  const row = getConfigRow(db);
  if (!row) return null;
  return {
    senderName: row.sender_name ?? '',
    senderBusiness: row.sender_business ?? '',
    mailingAddress: row.mailing_address ?? '',
    replyTo: row.reply_to ?? '',
    fromDomain: row.from_domain ?? '',
    dailySendCap: row.daily_send_cap,
    followupDays: row.followup_days,
    demoTtlDays: row.demo_ttl_days,
    demoBaseDomain: process.env.DEMO_BASE_DOMAIN ?? 'demo.example.com',
  };
}
