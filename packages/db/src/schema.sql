-- Storefront schema (SQLite dialect). Portable enough to port to Postgres later:
-- TEXT timestamps in ISO-8601, JSON stored as TEXT, integer-boolean flags.

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT,
  address       TEXT,
  phone         TEXT,
  lat           REAL,
  lng           REAL,
  website_url   TEXT,
  segment       TEXT CHECK (segment IN ('none', 'bad')),
  audit_json    TEXT,            -- JSON: website audit result
  score         REAL DEFAULT 0,
  contact_email TEXT,
  places_json   TEXT,            -- JSON: raw normalized PlaceResult from discovery
  -- discovered → qualified → demo_built → ready → contacted → replied → won → lost
  status        TEXT NOT NULL DEFAULT 'discovered',
  demo_url      TEXT,
  rating        REAL,
  review_count  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS demos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  template      TEXT NOT NULL,
  copy_json     TEXT,            -- JSON: hero/about/services/cta copy
  assets_json   TEXT,            -- JSON: photo refs, hours, map embed
  subdomain     TEXT,
  demo_url      TEXT,
  published     INTEGER NOT NULL DEFAULT 0,
  unpublish_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'call_script')),
  subject       TEXT,
  body          TEXT,
  -- draft → approved → sent | bounced | canceled
  status        TEXT NOT NULL DEFAULT 'draft',
  sent_at       TEXT,
  approved_by   TEXT,
  -- follow-up bookkeeping (NULL for the initial outreach message)
  sequence_id   INTEGER REFERENCES sequences(id) ON DELETE SET NULL,
  followup_step INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Permanent suppression list. Checked before EVERY send.
CREATE TABLE IF NOT EXISTS suppression (
  email      TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row config (id = 1). Sender identity + policy caps.
CREATE TABLE IF NOT EXISTS config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  sender_name     TEXT,
  sender_business TEXT,
  mailing_address TEXT,
  reply_to        TEXT,
  from_domain     TEXT,
  daily_send_cap  INTEGER DEFAULT 15,
  followup_days   INTEGER DEFAULT 4,
  demo_ttl_days   INTEGER DEFAULT 14,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit log: every state change and every send.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status);
CREATE INDEX IF NOT EXISTS idx_messages_lead  ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_demos_lead     ON demos(lead_id);
CREATE INDEX IF NOT EXISTS idx_events_lead    ON events(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

-- Follow-up sequences (Phase 2). A sequence is DRAFTED by automation but only
-- becomes sendable after explicit human approval. Hard limits live in code:
-- max 2 follow-ups, minimum spacing between sends, auto-cancel on
-- reply/unsubscribe. Every step still passes checkSendGate() at send time.
CREATE TABLE IF NOT EXISTS sequences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- draft → approved → completed | canceled
  status        TEXT NOT NULL DEFAULT 'draft',
  approved_by   TEXT,
  cancel_reason TEXT,
  max_followups INTEGER NOT NULL DEFAULT 2,
  spacing_days  INTEGER NOT NULL DEFAULT 4,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sequences_lead   ON sequences(lead_id);
CREATE INDEX IF NOT EXISTS idx_sequences_status ON sequences(status);
