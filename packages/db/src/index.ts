// Repository layer. Every function is async and written against the Driver
// interface only — SQLite (default) and Postgres are interchangeable. See
// driver.ts for dialect rules.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Driver } from './driver.js';

export * from './types.js';
export { openDb, sqlitePathFromUrl, SqliteDriver, PostgresDriver, toPgPlaceholders } from './driver.js';
export type { Driver, RunResult } from './driver.js';

import type {
  Lead,
  LeadStatus,
  Demo,
  Message,
  MessageStatus,
  Sequence,
  SequenceStatus,
  SmsMessage,
  SmsStatus,
  Suppression,
  Proposal,
  DomainRequest,
  ConfigRow,
  EventRow,
} from './types.js';

/** The repository handle passed to every function. */
export type DB = Driver;

const here = dirname(fileURLToPath(import.meta.url));

let singleton: DB | null = null;
let migrated = false;

/** Process-wide shared connection (unmigrated — prefer initDb()). */
export function getDb(): DB {
  if (!singleton) singleton = openDb();
  return singleton;
}

/** Shared connection with migrations applied. */
export async function initDb(): Promise<DB> {
  const db = getDb();
  if (!migrated) {
    await migrate(db);
    migrated = true;
  }
  return db;
}

export async function migrate(db: DB): Promise<void> {
  const file = db.dialect === 'postgres' ? 'schema.pg.sql' : 'schema.sql';
  const schema = readFileSync(resolve(here, file), 'utf8');
  await db.exec(schema);
  // Additive migrations for databases created before these columns existed.
  await ensureColumn(db, 'messages', 'sequence_id', 'BIGINT REFERENCES sequences(id) ON DELETE SET NULL');
  await ensureColumn(db, 'messages', 'followup_step', 'INTEGER');
  await ensureColumn(db, 'leads', 'close_reason', 'TEXT');
  await ensureColumn(db, 'leads', 'closed_at', 'TEXT');
}

async function ensureColumn(db: DB, table: string, column: string, ddl: string): Promise<void> {
  if (db.dialect === 'postgres') {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${ddl}`);
    return;
  }
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    // SQLite: BIGINT is an INTEGER affinity alias; the DDL works verbatim.
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Drop all data (used by `pnpm reset` + tests). */
export async function resetDb(db: DB): Promise<void> {
  const tables = [
    'events',
    'messages',
    'sms_messages',
    'sms_suppression',
    'sequences',
    'ab_assignments',
    'experiments',
    'proposals',
    'domain_requests',
    'demos',
    'suppression',
    'leads',
    'config',
  ];
  for (const t of tables) await db.run(`DELETE FROM ${t}`);
  if (db.dialect === 'sqlite') await db.run(`DELETE FROM sqlite_sequence`);
}

// ── Events (audit log) ──────────────────────────────────────────────────────

export async function logEvent(
  db: DB,
  type: string,
  leadId: number | null,
  payload?: unknown,
): Promise<void> {
  await db.run(`INSERT INTO events (lead_id, type, payload_json) VALUES (?, ?, ?)`, [
    leadId,
    type,
    payload === undefined ? null : JSON.stringify(payload),
  ]);
}

export async function listEvents(db: DB, leadId?: number): Promise<EventRow[]> {
  if (leadId === undefined) {
    return db.all<EventRow>(`SELECT * FROM events ORDER BY id DESC LIMIT 500`);
  }
  return db.all<EventRow>(`SELECT * FROM events WHERE lead_id = ? ORDER BY id DESC`, [leadId]);
}

// ── Leads ───────────────────────────────────────────────────────────────────

export interface NewLead {
  place_id: string;
  name: string;
  category?: string | null;
  address?: string | null;
  phone?: string | null;
  lat?: number | null;
  lng?: number | null;
  website_url?: string | null;
  rating?: number | null;
  review_count?: number | null;
  places_json?: string | null;
}

/** Insert if the place_id is new; returns the row either way. */
export async function upsertLead(
  db: DB,
  lead: NewLead,
): Promise<{ row: Lead; inserted: boolean }> {
  const existing = await db.get<Lead>(`SELECT * FROM leads WHERE place_id = ?`, [lead.place_id]);
  if (existing) return { row: existing, inserted: false };

  const id = await db.insert(
    `INSERT INTO leads (place_id, name, category, address, phone, lat, lng,
      website_url, rating, review_count, places_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')`,
    [
      lead.place_id,
      lead.name,
      lead.category ?? null,
      lead.address ?? null,
      lead.phone ?? null,
      lead.lat ?? null,
      lead.lng ?? null,
      lead.website_url ?? null,
      lead.rating ?? null,
      lead.review_count ?? null,
      lead.places_json ?? null,
    ],
  );
  const row = (await getLead(db, id))!;
  await logEvent(db, 'lead.discovered', row.id, { name: row.name, place_id: row.place_id });
  return { row, inserted: true };
}

export async function getLead(db: DB, id: number): Promise<Lead | undefined> {
  return db.get<Lead>(`SELECT * FROM leads WHERE id = ?`, [id]);
}

export async function listLeads(db: DB, status?: LeadStatus): Promise<Lead[]> {
  if (status) {
    return db.all<Lead>(`SELECT * FROM leads WHERE status = ? ORDER BY score DESC, id ASC`, [status]);
  }
  return db.all<Lead>(`SELECT * FROM leads ORDER BY score DESC, id ASC`);
}

const LEAD_COLUMNS = new Set([
  'place_id', 'name', 'category', 'address', 'phone', 'lat', 'lng', 'website_url',
  'segment', 'audit_json', 'score', 'contact_email', 'places_json', 'status',
  'demo_url', 'rating', 'review_count', 'close_reason', 'closed_at',
]);

export async function updateLead(db: DB, id: number, patch: Partial<Lead>): Promise<Lead> {
  const keys = Object.keys(patch).filter((k) => LEAD_COLUMNS.has(k));
  if (keys.length) {
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    await db.run(
      `UPDATE leads SET ${setClause}, updated_at = ${db.nowSql} WHERE id = ?`,
      [...keys.map((k) => (patch as Record<string, unknown>)[k]), id],
    );
  }
  return (await getLead(db, id))!;
}

/** Update status + write an audit event in one shot. */
export async function setLeadStatus(
  db: DB,
  id: number,
  status: LeadStatus,
  extra?: Partial<Lead>,
): Promise<Lead> {
  const before = await getLead(db, id);
  const row = await updateLead(db, id, { ...extra, status });
  await logEvent(db, 'lead.status', id, { from: before?.status, to: status });
  return row;
}

// ── Demos ───────────────────────────────────────────────────────────────────

export async function insertDemo(db: DB, demo: Omit<Demo, 'id' | 'created_at'>): Promise<Demo> {
  const id = await db.insert(
    `INSERT INTO demos (lead_id, template, copy_json, assets_json, subdomain,
      demo_url, published, unpublish_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      demo.lead_id,
      demo.template,
      demo.copy_json,
      demo.assets_json,
      demo.subdomain,
      demo.demo_url,
      demo.published,
      demo.unpublish_at,
    ],
  );
  return (await getDemo(db, id))!;
}

export async function getDemo(db: DB, id: number): Promise<Demo | undefined> {
  return db.get<Demo>(`SELECT * FROM demos WHERE id = ?`, [id]);
}

export async function getDemoByLead(db: DB, leadId: number): Promise<Demo | undefined> {
  return db.get<Demo>(`SELECT * FROM demos WHERE lead_id = ? ORDER BY id DESC LIMIT 1`, [leadId]);
}

const DEMO_COLUMNS = new Set([
  'lead_id', 'template', 'copy_json', 'assets_json', 'subdomain', 'demo_url',
  'published', 'unpublish_at',
]);

export async function updateDemo(db: DB, id: number, patch: Partial<Demo>): Promise<Demo> {
  const keys = Object.keys(patch).filter((k) => DEMO_COLUMNS.has(k));
  if (keys.length) {
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    await db.run(`UPDATE demos SET ${setClause} WHERE id = ?`, [
      ...keys.map((k) => (patch as Record<string, unknown>)[k]),
      id,
    ]);
  }
  return (await getDemo(db, id))!;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export async function insertMessage(
  db: DB,
  msg: Omit<
    Message,
    'id' | 'created_at' | 'sent_at' | 'approved_by' | 'sequence_id' | 'followup_step'
  > &
    Partial<Pick<Message, 'sent_at' | 'approved_by' | 'sequence_id' | 'followup_step'>>,
): Promise<Message> {
  const id = await db.insert(
    `INSERT INTO messages (lead_id, channel, subject, body, status, sent_at, approved_by,
      sequence_id, followup_step)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.lead_id,
      msg.channel,
      msg.subject,
      msg.body,
      msg.status,
      msg.sent_at ?? null,
      msg.approved_by ?? null,
      msg.sequence_id ?? null,
      msg.followup_step ?? null,
    ],
  );
  const row = (await getMessage(db, id))!;
  await logEvent(db, 'message.draft', row.lead_id, {
    message_id: row.id,
    subject: row.subject,
    ...(row.sequence_id ? { sequence_id: row.sequence_id, followup_step: row.followup_step } : {}),
  });
  return row;
}

export async function getMessage(db: DB, id: number): Promise<Message | undefined> {
  return db.get<Message>(`SELECT * FROM messages WHERE id = ?`, [id]);
}

export async function getMessageByLead(db: DB, leadId: number): Promise<Message | undefined> {
  return db.get<Message>(`SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1`, [
    leadId,
  ]);
}

export async function updateMessageStatus(
  db: DB,
  id: number,
  status: MessageStatus,
  extra?: Partial<Pick<Message, 'sent_at' | 'approved_by'>>,
): Promise<Message> {
  await db.run(
    `UPDATE messages SET status = ?,
       sent_at = COALESCE(?, sent_at),
       approved_by = COALESCE(?, approved_by)
     WHERE id = ?`,
    [status, extra?.sent_at ?? null, extra?.approved_by ?? null, id],
  );
  return (await getMessage(db, id))!;
}

/** Count of emails actually sent today (UTC date). Drives the daily cap. */
export async function countSentToday(db: DB): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND ${db.todayCond('sent_at')}`,
  );
  return row!.n;
}

// ── Sequences (follow-ups) ───────────────────────────────────────────────────

export async function insertSequence(
  db: DB,
  seq: Pick<Sequence, 'lead_id' | 'max_followups' | 'spacing_days'>,
): Promise<Sequence> {
  const id = await db.insert(
    `INSERT INTO sequences (lead_id, status, max_followups, spacing_days)
     VALUES (?, 'draft', ?, ?)`,
    [seq.lead_id, seq.max_followups, seq.spacing_days],
  );
  const row = (await getSequence(db, id))!;
  await logEvent(db, 'sequence.drafted', row.lead_id, {
    sequence_id: row.id,
    max_followups: row.max_followups,
    spacing_days: row.spacing_days,
  });
  return row;
}

export async function getSequence(db: DB, id: number): Promise<Sequence | undefined> {
  return db.get<Sequence>(`SELECT * FROM sequences WHERE id = ?`, [id]);
}

export async function getSequenceByLead(db: DB, leadId: number): Promise<Sequence | undefined> {
  return db.get<Sequence>(`SELECT * FROM sequences WHERE lead_id = ? ORDER BY id DESC LIMIT 1`, [
    leadId,
  ]);
}

export async function listSequences(db: DB, status?: SequenceStatus): Promise<Sequence[]> {
  if (status) {
    return db.all<Sequence>(`SELECT * FROM sequences WHERE status = ? ORDER BY id ASC`, [status]);
  }
  return db.all<Sequence>(`SELECT * FROM sequences ORDER BY id ASC`);
}

export async function updateSequenceStatus(
  db: DB,
  id: number,
  status: SequenceStatus,
  extra?: Partial<Pick<Sequence, 'approved_by' | 'cancel_reason'>>,
): Promise<Sequence> {
  await db.run(
    `UPDATE sequences SET status = ?,
       approved_by = COALESCE(?, approved_by),
       cancel_reason = COALESCE(?, cancel_reason),
       updated_at = ${db.nowSql}
     WHERE id = ?`,
    [status, extra?.approved_by ?? null, extra?.cancel_reason ?? null, id],
  );
  return (await getSequence(db, id))!;
}

/** Follow-up messages belonging to a sequence, in step order. */
export async function listSequenceMessages(db: DB, sequenceId: number): Promise<Message[]> {
  return db.all<Message>(`SELECT * FROM messages WHERE sequence_id = ? ORDER BY followup_step ASC`, [
    sequenceId,
  ]);
}

// ── SMS (separate channel, separate gate) ────────────────────────────────────

export async function insertSms(
  db: DB,
  sms: Pick<SmsMessage, 'lead_id' | 'to_phone' | 'body'>,
): Promise<SmsMessage> {
  const id = await db.insert(
    `INSERT INTO sms_messages (lead_id, to_phone, body, status) VALUES (?, ?, ?, 'draft')`,
    [sms.lead_id, sms.to_phone, sms.body],
  );
  const row = (await getSms(db, id))!;
  await logEvent(db, 'sms.drafted', row.lead_id, { sms_id: row.id });
  return row;
}

export async function getSms(db: DB, id: number): Promise<SmsMessage | undefined> {
  return db.get<SmsMessage>(`SELECT * FROM sms_messages WHERE id = ?`, [id]);
}

export async function getSmsByLead(db: DB, leadId: number): Promise<SmsMessage | undefined> {
  return db.get<SmsMessage>(`SELECT * FROM sms_messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1`, [
    leadId,
  ]);
}

export async function updateSmsStatus(
  db: DB,
  id: number,
  status: SmsStatus,
  extra?: Partial<Pick<SmsMessage, 'tcpa_basis' | 'approved_by' | 'sent_at' | 'provider_id'>>,
): Promise<SmsMessage> {
  await db.run(
    `UPDATE sms_messages SET status = ?,
       tcpa_basis = COALESCE(?, tcpa_basis),
       approved_by = COALESCE(?, approved_by),
       sent_at = COALESCE(?, sent_at),
       provider_id = COALESCE(?, provider_id)
     WHERE id = ?`,
    [
      status,
      extra?.tcpa_basis ?? null,
      extra?.approved_by ?? null,
      extra?.sent_at ?? null,
      extra?.provider_id ?? null,
      id,
    ],
  );
  return (await getSms(db, id))!;
}

export async function countSmsSentToday(db: DB): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sms_messages WHERE status = 'sent' AND ${db.todayCond('sent_at')}`,
  );
  return row!.n;
}

const normPhone = (p: string) => p.replace(/[^0-9+]/g, '');

export async function isPhoneSuppressed(db: DB, phone: string): Promise<boolean> {
  const row = await db.get(`SELECT phone FROM sms_suppression WHERE phone = ?`, [normPhone(phone)]);
  return !!row;
}

export async function addPhoneSuppression(db: DB, phone: string, reason: string): Promise<void> {
  await db.run(
    `INSERT INTO sms_suppression (phone, reason) VALUES (?, ?) ON CONFLICT (phone) DO NOTHING`,
    [normPhone(phone), reason],
  );
  await logEvent(db, 'sms.suppression.add', null, { phone: normPhone(phone), reason });
}

// ── Suppression (email) ──────────────────────────────────────────────────────

export async function isSuppressed(db: DB, email: string): Promise<boolean> {
  const row = await db.get(`SELECT email FROM suppression WHERE email = ?`, [
    email.toLowerCase().trim(),
  ]);
  return !!row;
}

export async function addSuppression(db: DB, email: string, reason: string): Promise<void> {
  await db.run(
    `INSERT INTO suppression (email, reason) VALUES (?, ?) ON CONFLICT (email) DO NOTHING`,
    [email.toLowerCase().trim(), reason],
  );
  await logEvent(db, 'suppression.add', null, { email, reason });
}

export async function listSuppression(db: DB): Promise<Suppression[]> {
  return db.all<Suppression>(`SELECT * FROM suppression ORDER BY created_at DESC`);
}

// ── Proposals + domain requests ──────────────────────────────────────────────

export async function insertProposal(db: DB, p: Omit<Proposal, 'id' | 'created_at'>): Promise<Proposal> {
  const id = await db.insert(
    `INSERT INTO proposals (lead_id, slug, url, payment_link_url, payment_link_id,
      price_cents, monthly_cents, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.lead_id,
      p.slug,
      p.url,
      p.payment_link_url,
      p.payment_link_id,
      p.price_cents,
      p.monthly_cents,
      p.currency,
    ],
  );
  const row = (await db.get<Proposal>(`SELECT * FROM proposals WHERE id = ?`, [id]))!;
  await logEvent(db, 'proposal.created', row.lead_id, {
    proposal_id: row.id,
    url: row.url,
    price_cents: row.price_cents,
  });
  return row;
}

export async function getProposalByLead(db: DB, leadId: number): Promise<Proposal | undefined> {
  return db.get<Proposal>(`SELECT * FROM proposals WHERE lead_id = ? ORDER BY id DESC LIMIT 1`, [
    leadId,
  ]);
}

export async function insertDomainRequest(
  db: DB,
  r: Pick<DomainRequest, 'lead_id' | 'domain' | 'token' | 'requested_by'>,
): Promise<DomainRequest> {
  const id = await db.insert(
    `INSERT INTO domain_requests (lead_id, domain, token, requested_by, status)
     VALUES (?, ?, ?, ?, 'requested')`,
    [r.lead_id, r.domain, r.token, r.requested_by],
  );
  const row = (await db.get<DomainRequest>(`SELECT * FROM domain_requests WHERE id = ?`, [id]))!;
  await logEvent(db, 'domain.requested', row.lead_id, { request_id: row.id, domain: row.domain });
  return row;
}

export async function getDomainRequestByToken(db: DB, token: string): Promise<DomainRequest | undefined> {
  return db.get<DomainRequest>(`SELECT * FROM domain_requests WHERE token = ?`, [token]);
}

export async function decideDomainRequest(
  db: DB,
  token: string,
  decision: 'approved' | 'declined',
  decidedBy: string,
): Promise<DomainRequest> {
  const req = await getDomainRequestByToken(db, token);
  if (!req) throw new Error('Domain request not found');
  if (req.status !== 'requested') return req; // idempotent: first decision wins
  await db.run(
    `UPDATE domain_requests SET status = ?, decided_by = ?, decided_at = ${db.nowSql} WHERE token = ?`,
    [decision, decidedBy, token],
  );
  const row = (await getDomainRequestByToken(db, token))!;
  await logEvent(db, `domain.${decision}`, row.lead_id, {
    request_id: row.id,
    domain: row.domain,
    decided_by: decidedBy,
  });
  return row;
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function getConfigRow(db: DB): Promise<ConfigRow | undefined> {
  return db.get<ConfigRow>(`SELECT * FROM config WHERE id = 1`);
}

export async function upsertConfig(
  db: DB,
  cfg: Partial<Omit<ConfigRow, 'id'>>,
): Promise<ConfigRow> {
  const existing = await getConfigRow(db);
  if (!existing) {
    await db.run(
      `INSERT INTO config (id, sender_name, sender_business, mailing_address,
        reply_to, from_domain, daily_send_cap, followup_days, demo_ttl_days)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cfg.sender_name ?? null,
        cfg.sender_business ?? null,
        cfg.mailing_address ?? null,
        cfg.reply_to ?? null,
        cfg.from_domain ?? null,
        cfg.daily_send_cap ?? 15,
        cfg.followup_days ?? 4,
        cfg.demo_ttl_days ?? 14,
      ],
    );
  } else {
    const merged = { ...existing, ...cfg };
    await db.run(
      `UPDATE config SET sender_name=?, sender_business=?, mailing_address=?,
        reply_to=?, from_domain=?, daily_send_cap=?, followup_days=?,
        demo_ttl_days=?, updated_at=${db.nowSql} WHERE id = 1`,
      [
        merged.sender_name,
        merged.sender_business,
        merged.mailing_address,
        merged.reply_to,
        merged.from_domain,
        merged.daily_send_cap,
        merged.followup_days,
        merged.demo_ttl_days,
      ],
    );
  }
  return (await getConfigRow(db))!;
}
