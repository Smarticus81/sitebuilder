import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './types.js';
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
  ConfigRow,
  EventRow,
} from './types.js';

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve a DATABASE_URL like `sqlite:./data/storefront.db` to a file path. */
export function sqlitePathFromUrl(url: string | undefined): string {
  const raw = url ?? 'sqlite:./data/storefront.db';
  if (raw.startsWith('postgres://') || raw.startsWith('postgresql://')) {
    throw new Error(
      'Postgres DATABASE_URL detected, but Phase 1 ships the SQLite driver only. ' +
        'Set DATABASE_URL=sqlite:./data/storefront.db for the local run.',
    );
  }
  const path = raw.replace(/^sqlite:/, '');
  if (path === ':memory:') return path;
  return resolve(process.cwd(), path);
}

let singleton: DB | null = null;

export function openDb(url = process.env.DATABASE_URL): DB {
  const path = sqlitePathFromUrl(url);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Process-wide shared connection. */
export function getDb(): DB {
  if (!singleton) {
    singleton = openDb();
    migrate(singleton);
  }
  return singleton;
}

export function migrate(db: DB): void {
  const schema = readFileSync(resolve(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Additive migrations for databases created before these columns existed.
  ensureColumn(db, 'messages', 'sequence_id', 'INTEGER REFERENCES sequences(id) ON DELETE SET NULL');
  ensureColumn(db, 'messages', 'followup_step', 'INTEGER');
}

function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Drop all data (used by `pnpm reset`). */
export function resetDb(db: DB): void {
  db.exec(`
    DELETE FROM events;
    DELETE FROM messages;
    DELETE FROM sms_messages;
    DELETE FROM sms_suppression;
    DELETE FROM sequences;
    DELETE FROM demos;
    DELETE FROM suppression;
    DELETE FROM leads;
    DELETE FROM config;
    DELETE FROM sqlite_sequence;
  `);
}

// ── Events (audit log) ──────────────────────────────────────────────────────

export function logEvent(
  db: DB,
  type: string,
  leadId: number | null,
  payload?: unknown,
): void {
  db.prepare(
    `INSERT INTO events (lead_id, type, payload_json) VALUES (?, ?, ?)`,
  ).run(leadId, type, payload === undefined ? null : JSON.stringify(payload));
}

export function listEvents(db: DB, leadId?: number): EventRow[] {
  if (leadId === undefined) {
    return db
      .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT 500`)
      .all() as EventRow[];
  }
  return db
    .prepare(`SELECT * FROM events WHERE lead_id = ? ORDER BY id DESC`)
    .all(leadId) as EventRow[];
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
export function upsertLead(db: DB, lead: NewLead): { row: Lead; inserted: boolean } {
  const existing = db
    .prepare(`SELECT * FROM leads WHERE place_id = ?`)
    .get(lead.place_id) as Lead | undefined;
  if (existing) return { row: existing, inserted: false };

  const info = db
    .prepare(
      `INSERT INTO leads (place_id, name, category, address, phone, lat, lng,
        website_url, rating, review_count, places_json, status)
       VALUES (@place_id, @name, @category, @address, @phone, @lat, @lng,
        @website_url, @rating, @review_count, @places_json, 'discovered')`,
    )
    .run({
      place_id: lead.place_id,
      name: lead.name,
      category: lead.category ?? null,
      address: lead.address ?? null,
      phone: lead.phone ?? null,
      lat: lead.lat ?? null,
      lng: lead.lng ?? null,
      website_url: lead.website_url ?? null,
      rating: lead.rating ?? null,
      review_count: lead.review_count ?? null,
      places_json: lead.places_json ?? null,
    });
  const row = getLead(db, Number(info.lastInsertRowid))!;
  logEvent(db, 'lead.discovered', row.id, { name: row.name, place_id: row.place_id });
  return { row, inserted: true };
}

export function getLead(db: DB, id: number): Lead | undefined {
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id) as Lead | undefined;
}

export function listLeads(db: DB, status?: LeadStatus): Lead[] {
  if (status) {
    return db
      .prepare(`SELECT * FROM leads WHERE status = ? ORDER BY score DESC, id ASC`)
      .all(status) as Lead[];
  }
  return db
    .prepare(`SELECT * FROM leads ORDER BY score DESC, id ASC`)
    .all() as Lead[];
}

export function updateLead(db: DB, id: number, patch: Partial<Lead>): Lead {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length) {
    const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(
      `UPDATE leads SET ${setClause}, updated_at = datetime('now') WHERE id = @id`,
    ).run({ ...patch, id });
  }
  return getLead(db, id)!;
}

/** Update status + write an audit event in one shot. */
export function setLeadStatus(
  db: DB,
  id: number,
  status: LeadStatus,
  extra?: Partial<Lead>,
): Lead {
  const before = getLead(db, id);
  const row = updateLead(db, id, { ...extra, status });
  logEvent(db, 'lead.status', id, { from: before?.status, to: status });
  return row;
}

// ── Demos ───────────────────────────────────────────────────────────────────

export function insertDemo(
  db: DB,
  demo: Omit<Demo, 'id' | 'created_at'>,
): Demo {
  const info = db
    .prepare(
      `INSERT INTO demos (lead_id, template, copy_json, assets_json, subdomain,
        demo_url, published, unpublish_at)
       VALUES (@lead_id, @template, @copy_json, @assets_json, @subdomain,
        @demo_url, @published, @unpublish_at)`,
    )
    .run(demo);
  return getDemo(db, Number(info.lastInsertRowid))!;
}

export function getDemo(db: DB, id: number): Demo | undefined {
  return db.prepare(`SELECT * FROM demos WHERE id = ?`).get(id) as Demo | undefined;
}

export function getDemoByLead(db: DB, leadId: number): Demo | undefined {
  return db
    .prepare(`SELECT * FROM demos WHERE lead_id = ? ORDER BY id DESC LIMIT 1`)
    .get(leadId) as Demo | undefined;
}

export function updateDemo(db: DB, id: number, patch: Partial<Demo>): Demo {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length) {
    const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE demos SET ${setClause} WHERE id = @id`).run({ ...patch, id });
  }
  return getDemo(db, id)!;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function insertMessage(
  db: DB,
  msg: Omit<
    Message,
    'id' | 'created_at' | 'sent_at' | 'approved_by' | 'sequence_id' | 'followup_step'
  > &
    Partial<Pick<Message, 'sent_at' | 'approved_by' | 'sequence_id' | 'followup_step'>>,
): Message {
  const info = db
    .prepare(
      `INSERT INTO messages (lead_id, channel, subject, body, status, sent_at, approved_by,
        sequence_id, followup_step)
       VALUES (@lead_id, @channel, @subject, @body, @status, @sent_at, @approved_by,
        @sequence_id, @followup_step)`,
    )
    .run({
      sent_at: null,
      approved_by: null,
      sequence_id: null,
      followup_step: null,
      ...msg,
    });
  const row = getMessage(db, Number(info.lastInsertRowid))!;
  logEvent(db, 'message.draft', row.lead_id, {
    message_id: row.id,
    subject: row.subject,
    ...(row.sequence_id ? { sequence_id: row.sequence_id, followup_step: row.followup_step } : {}),
  });
  return row;
}

export function getMessage(db: DB, id: number): Message | undefined {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | Message
    | undefined;
}

export function getMessageByLead(db: DB, leadId: number): Message | undefined {
  return db
    .prepare(`SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1`)
    .get(leadId) as Message | undefined;
}

export function updateMessageStatus(
  db: DB,
  id: number,
  status: MessageStatus,
  extra?: Partial<Message>,
): Message {
  const keys = ['status', ...Object.keys(extra ?? {})];
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE messages SET ${setClause} WHERE id = @id`).run({
    status,
    ...extra,
    id,
  });
  return getMessage(db, id)!;
}

/** Count of emails actually sent today (UTC date). Drives the daily cap. */
export function countSentToday(db: DB): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE status = 'sent' AND date(sent_at) = date('now')`,
    )
    .get() as { n: number };
  return row.n;
}

// ── Sequences (follow-ups) ───────────────────────────────────────────────────

export function insertSequence(
  db: DB,
  seq: Pick<Sequence, 'lead_id' | 'max_followups' | 'spacing_days'>,
): Sequence {
  const info = db
    .prepare(
      `INSERT INTO sequences (lead_id, status, max_followups, spacing_days)
       VALUES (@lead_id, 'draft', @max_followups, @spacing_days)`,
    )
    .run(seq);
  const row = getSequence(db, Number(info.lastInsertRowid))!;
  logEvent(db, 'sequence.drafted', row.lead_id, {
    sequence_id: row.id,
    max_followups: row.max_followups,
    spacing_days: row.spacing_days,
  });
  return row;
}

export function getSequence(db: DB, id: number): Sequence | undefined {
  return db.prepare(`SELECT * FROM sequences WHERE id = ?`).get(id) as
    | Sequence
    | undefined;
}

export function getSequenceByLead(db: DB, leadId: number): Sequence | undefined {
  return db
    .prepare(`SELECT * FROM sequences WHERE lead_id = ? ORDER BY id DESC LIMIT 1`)
    .get(leadId) as Sequence | undefined;
}

export function listSequences(db: DB, status?: SequenceStatus): Sequence[] {
  if (status) {
    return db
      .prepare(`SELECT * FROM sequences WHERE status = ? ORDER BY id ASC`)
      .all(status) as Sequence[];
  }
  return db.prepare(`SELECT * FROM sequences ORDER BY id ASC`).all() as Sequence[];
}

export function updateSequenceStatus(
  db: DB,
  id: number,
  status: SequenceStatus,
  extra?: Partial<Pick<Sequence, 'approved_by' | 'cancel_reason'>>,
): Sequence {
  db.prepare(
    `UPDATE sequences SET status = @status,
       approved_by = COALESCE(@approved_by, approved_by),
       cancel_reason = COALESCE(@cancel_reason, cancel_reason),
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({ id, status, approved_by: extra?.approved_by ?? null, cancel_reason: extra?.cancel_reason ?? null });
  return getSequence(db, id)!;
}

/** Follow-up messages belonging to a sequence, in step order. */
export function listSequenceMessages(db: DB, sequenceId: number): Message[] {
  return db
    .prepare(`SELECT * FROM messages WHERE sequence_id = ? ORDER BY followup_step ASC`)
    .all(sequenceId) as Message[];
}

// ── Suppression ──────────────────────────────────────────────────────────────

export function isSuppressed(db: DB, email: string): boolean {
  const row = db
    .prepare(`SELECT email FROM suppression WHERE email = ?`)
    .get(email.toLowerCase().trim());
  return !!row;
}

export function addSuppression(db: DB, email: string, reason: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO suppression (email, reason) VALUES (?, ?)`,
  ).run(email.toLowerCase().trim(), reason);
  logEvent(db, 'suppression.add', null, { email, reason });
}

export function listSuppression(db: DB): Suppression[] {
  return db
    .prepare(`SELECT * FROM suppression ORDER BY created_at DESC`)
    .all() as Suppression[];
}

// ── SMS (Phase 3 — separate channel, separate gate) ──────────────────────────

export function insertSms(
  db: DB,
  sms: Pick<SmsMessage, 'lead_id' | 'to_phone' | 'body'>,
): SmsMessage {
  const info = db
    .prepare(
      `INSERT INTO sms_messages (lead_id, to_phone, body, status)
       VALUES (@lead_id, @to_phone, @body, 'draft')`,
    )
    .run(sms);
  const row = getSms(db, Number(info.lastInsertRowid))!;
  logEvent(db, 'sms.drafted', row.lead_id, { sms_id: row.id });
  return row;
}

export function getSms(db: DB, id: number): SmsMessage | undefined {
  return db.prepare(`SELECT * FROM sms_messages WHERE id = ?`).get(id) as
    | SmsMessage
    | undefined;
}

export function getSmsByLead(db: DB, leadId: number): SmsMessage | undefined {
  return db
    .prepare(`SELECT * FROM sms_messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1`)
    .get(leadId) as SmsMessage | undefined;
}

export function updateSmsStatus(
  db: DB,
  id: number,
  status: SmsStatus,
  extra?: Partial<Pick<SmsMessage, 'tcpa_basis' | 'approved_by' | 'sent_at' | 'provider_id'>>,
): SmsMessage {
  db.prepare(
    `UPDATE sms_messages SET status = @status,
       tcpa_basis = COALESCE(@tcpa_basis, tcpa_basis),
       approved_by = COALESCE(@approved_by, approved_by),
       sent_at = COALESCE(@sent_at, sent_at),
       provider_id = COALESCE(@provider_id, provider_id)
     WHERE id = @id`,
  ).run({
    id,
    status,
    tcpa_basis: extra?.tcpa_basis ?? null,
    approved_by: extra?.approved_by ?? null,
    sent_at: extra?.sent_at ?? null,
    provider_id: extra?.provider_id ?? null,
  });
  return getSms(db, id)!;
}

export function countSmsSentToday(db: DB): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sms_messages
       WHERE status = 'sent' AND date(sent_at) = date('now')`,
    )
    .get() as { n: number };
  return row.n;
}

const normPhone = (p: string) => p.replace(/[^0-9+]/g, '');

export function isPhoneSuppressed(db: DB, phone: string): boolean {
  return !!db
    .prepare(`SELECT phone FROM sms_suppression WHERE phone = ?`)
    .get(normPhone(phone));
}

export function addPhoneSuppression(db: DB, phone: string, reason: string): void {
  db.prepare(`INSERT OR IGNORE INTO sms_suppression (phone, reason) VALUES (?, ?)`).run(
    normPhone(phone),
    reason,
  );
  logEvent(db, 'sms.suppression.add', null, { phone: normPhone(phone), reason });
}

// ── Config ───────────────────────────────────────────────────────────────────

export function getConfigRow(db: DB): ConfigRow | undefined {
  return db.prepare(`SELECT * FROM config WHERE id = 1`).get() as
    | ConfigRow
    | undefined;
}

export function upsertConfig(db: DB, cfg: Partial<Omit<ConfigRow, 'id'>>): ConfigRow {
  const existing = getConfigRow(db);
  if (!existing) {
    db.prepare(
      `INSERT INTO config (id, sender_name, sender_business, mailing_address,
        reply_to, from_domain, daily_send_cap, followup_days, demo_ttl_days)
       VALUES (1, @sender_name, @sender_business, @mailing_address, @reply_to,
        @from_domain, @daily_send_cap, @followup_days, @demo_ttl_days)`,
    ).run({
      sender_name: cfg.sender_name ?? null,
      sender_business: cfg.sender_business ?? null,
      mailing_address: cfg.mailing_address ?? null,
      reply_to: cfg.reply_to ?? null,
      from_domain: cfg.from_domain ?? null,
      daily_send_cap: cfg.daily_send_cap ?? 15,
      followup_days: cfg.followup_days ?? 4,
      demo_ttl_days: cfg.demo_ttl_days ?? 14,
    });
  } else {
    const merged = { ...existing, ...cfg };
    db.prepare(
      `UPDATE config SET sender_name=@sender_name, sender_business=@sender_business,
        mailing_address=@mailing_address, reply_to=@reply_to, from_domain=@from_domain,
        daily_send_cap=@daily_send_cap, followup_days=@followup_days,
        demo_ttl_days=@demo_ttl_days, updated_at=datetime('now') WHERE id = 1`,
    ).run(merged);
  }
  return getConfigRow(db)!;
}
