# Storefront — notes for future sessions

Local web-agency pipeline. Find businesses with bad/no websites → auto-build a demo →
queue compliant outreach → follow up → close. Human approval gate at every irreversible
step. Quality over volume.

## Golden rules (from the spec — do not violate)
- **Human gates** (build / outreach-ready / send / sequence / SMS) stay non-bypassable.
- **No auto-send, ever.** `core/sender.ts::sendApprovedMessage` → `checkSendGate` is the
  only path to the email wire (grep: exactly one `email.send(` call site). It hard-requires:
  message `approved`, not suppressed, under daily cap, CAN-SPAM-valid. SMS mirrors this via
  `checkSmsGate` (TCPA basis required at approval, STOP list, quiet hours, cap).
- **CAN-SPAM in code:** physical address + working unsubscribe on every email; suppression
  is permanent and checked before every send (incl. follow-ups).
- **Legitimate sourcing only:** Places API for discovery; reading a prospect's own site is OK;
  no scraping Yelp/Maps results pages.
- **No autonomous spend** — Stripe = payment links only (no charge API surface);
  domains = approval-link requests only. Parent is the legal sender (`.env` identity).
- **A/B winners are reported, never auto-promoted** — concluding is a human act.

## Architecture
- pnpm monorepo, ESM + `tsx` (no build step for backend).
- **DB is a Driver abstraction** (`packages/db/src/driver.ts`): SQLite (better-sqlite3,
  local default) and Postgres (pg, production) behind one async repository API with
  positional `?` params. Keep `schema.sql` and `schema.pg.sql` in lockstep; additive
  columns go through `ensureColumn` in `migrate()`. All repo functions are async.
- `packages/{db,net,places,llm,email,sms,payments,core}` + `apps/{worker,dashboard}`.
- **Mock-first, live-ready:** every external service has a provider interface with a mock
  (default) and a live impl behind an env-key factory (see `core/src/context.ts`).
  Live HTTP goes through `@storefront/net` (retries+jitter, timeouts, Retry-After,
  secret-safe logging into `events`). Email sends carry Idempotency-Keys; SMS is never
  retried (no idempotency on Twilio).
- Worker: `app.ts` = express app factory (auth middleware, rate limiting, webhooks) used
  by tests; `server.ts` = boot validation + listen + in-process scheduler. Stages in
  `stages.ts`; CLI `cli.ts`; tests `acceptance.ts` / `parity.ts`; ops `doctor.ts` / `smoke.ts`.

## Run / verify
- `pnpm acceptance` — 151 headless assertions, zero keys (the fast confidence check).
  Also passes with `DATABASE_URL=postgres://…` (verified on PG 16).
- `pnpm parity` — same repo scenario on SQLite + Postgres (needs `POSTGRES_URL` for pg leg).
- `pnpm doctor` — env validation, live-adapter pings, SPF/DKIM/DMARC. `pnpm smoke` — keyed
  live calls (never sends mail).
- `pnpm typecheck` (backend) / `pnpm typecheck:ui` (dashboard).
- `pnpm server` (:8787) + `pnpm dashboard` (:5173) for the manual flow.

## Gotchas
- `better-sqlite3` native binding: if install can't fetch node headers (403 via proxy),
  build with `npm_config_nodedir=/opt/node22 pnpm install` or run `npx prebuild-install`
  in its package dir. Allow-listed via root `pnpm.onlyBuiltDependencies`.
- `.env` must exist (`cp .env.example .env`) or the CAN-SPAM gate rightfully blocks
  everything (no mailing address / reply-to).
- Audit staleness year is pinned (2026) in `core/src/audit.ts` for deterministic mock
  audits. Demo TTLs use real time; acceptance passes explicit `now` values.
- Background `pnpm server` gets reaped by the tool harness; test the API by starting +
  curling + killing within a single shell invocation (or use `buildApp` on an ephemeral
  port like acceptance does).
- Auth: when `DASHBOARD_PASSWORD` is set, `/api/*` needs `Authorization: Bearer <token>`
  from `POST /api/login`. In production boot refuses to start without it.

## Status
Phases 1–4 + production hardening implemented; suite at 151 assertions. Live-adapter
exercise requires operator keys (`doctor`/`smoke` are the verification path). See
README "Honest status" + operator runbook.
