-- Storefront schema — Postgres dialect. Mirrors schema.sql exactly:
-- TEXT timestamps in UTC 'YYYY-MM-DD HH:MM:SS', JSON stored as TEXT,
-- integer-boolean flags. Keep the two files in lockstep.

CREATE OR REPLACE FUNCTION sf_now() RETURNS TEXT AS
  $$ SELECT to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS') $$
LANGUAGE SQL;

CREATE TABLE IF NOT EXISTS leads (
  id            BIGSERIAL PRIMARY KEY,
  place_id      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT,
  address       TEXT,
  phone         TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  website_url   TEXT,
  segment       TEXT CHECK (segment IN ('none', 'bad')),
  audit_json    TEXT,
  score         DOUBLE PRECISION DEFAULT 0,
  contact_email TEXT,
  places_json   TEXT,
  status        TEXT NOT NULL DEFAULT 'discovered',
  demo_url      TEXT,
  rating        DOUBLE PRECISION,
  review_count  INTEGER,
  close_reason  TEXT,
  closed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT sf_now(),
  updated_at    TEXT NOT NULL DEFAULT sf_now()
);

CREATE TABLE IF NOT EXISTS demos (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  template      TEXT NOT NULL,
  copy_json     TEXT,
  assets_json   TEXT,
  subdomain     TEXT,
  demo_url      TEXT,
  published     INTEGER NOT NULL DEFAULT 0,
  unpublish_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT sf_now()
);

CREATE TABLE IF NOT EXISTS sequences (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'draft',
  approved_by   TEXT,
  cancel_reason TEXT,
  max_followups INTEGER NOT NULL DEFAULT 2,
  spacing_days  INTEGER NOT NULL DEFAULT 4,
  created_at    TEXT NOT NULL DEFAULT sf_now(),
  updated_at    TEXT NOT NULL DEFAULT sf_now()
);
CREATE INDEX IF NOT EXISTS idx_sequences_lead   ON sequences(lead_id);
CREATE INDEX IF NOT EXISTS idx_sequences_status ON sequences(status);

CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'call_script')),
  subject       TEXT,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  sent_at       TEXT,
  approved_by   TEXT,
  sequence_id   BIGINT REFERENCES sequences(id) ON DELETE SET NULL,
  followup_step INTEGER,
  created_at    TEXT NOT NULL DEFAULT sf_now()
);

CREATE TABLE IF NOT EXISTS suppression (
  email      TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT sf_now()
);

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
  updated_at      TEXT NOT NULL DEFAULT sf_now()
);

CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  lead_id      BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL DEFAULT sf_now()
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  to_phone    TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  tcpa_basis  TEXT,
  approved_by TEXT,
  sent_at     TEXT,
  provider_id TEXT,
  created_at  TEXT NOT NULL DEFAULT sf_now()
);
CREATE INDEX IF NOT EXISTS idx_sms_lead   ON sms_messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_sms_status ON sms_messages(status);

CREATE TABLE IF NOT EXISTS sms_suppression (
  phone      TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT sf_now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id               BIGSERIAL PRIMARY KEY,
  lead_id          BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  slug             TEXT NOT NULL,
  url              TEXT,
  payment_link_url TEXT,
  payment_link_id  TEXT,
  price_cents      INTEGER NOT NULL,
  monthly_cents    INTEGER,
  currency         TEXT NOT NULL DEFAULT 'usd',
  created_at       TEXT NOT NULL DEFAULT sf_now()
);
CREATE INDEX IF NOT EXISTS idx_proposals_lead ON proposals(lead_id);

CREATE TABLE IF NOT EXISTS domain_requests (
  id           BIGSERIAL PRIMARY KEY,
  lead_id      BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  domain       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'requested',
  token        TEXT NOT NULL UNIQUE,
  requested_by TEXT,
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT sf_now()
);
CREATE INDEX IF NOT EXISTS idx_domain_requests_lead ON domain_requests(lead_id);

CREATE TABLE IF NOT EXISTS ab_assignments (
  experiment TEXT NOT NULL,
  lead_id    BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  variant    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT sf_now(),
  PRIMARY KEY (experiment, lead_id)
);

CREATE TABLE IF NOT EXISTS experiments (
  name         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  variants     TEXT NOT NULL,
  winner       TEXT,
  concluded_by TEXT,
  concluded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_status    ON leads(status);
CREATE INDEX IF NOT EXISTS idx_messages_lead   ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_demos_lead      ON demos(lead_id);
CREATE INDEX IF NOT EXISTS idx_events_lead     ON events(lead_id);
