# Storefront — notes for future sessions

Local web-agency pipeline. Find businesses with bad/no websites → auto-build a demo →
queue compliant outreach. Human approval gate at every irreversible step. Quality over volume.

## Golden rules (from the spec — do not violate)
- **Three human gates** (build / outreach-ready / send) must stay non-bypassable.
- **No auto-send, ever.** `core/sender.ts::checkSendGate` is the only path to the wire and
  hard-requires: message `approved`, not suppressed, under daily cap, CAN-SPAM-valid.
- **CAN-SPAM in code:** every email gets the physical mailing address + working unsubscribe.
  Suppression is permanent and checked before every send.
- **Legitimate sourcing only:** Places API for discovery; reading a prospect's own site is OK;
  no scraping Yelp/Maps results pages.
- **No autonomous charges/domain buys** — generate approval links instead (Phase 3).
- Parent is the legal sender; identity comes from `.env` / `config` table.

## Architecture
- pnpm monorepo, ESM + `tsx` (no build step for backend). SQLite via `better-sqlite3`.
- `packages/{db,places,llm,email,core}` + `apps/{worker,dashboard}`.
- **Mock-first, live-ready:** every external service has a provider interface with a mock
  (default) and a live impl behind an env-key factory. See `packages/*/src/index.ts` factories
  and `core/src/context.ts`.
- Stages in `apps/worker/src/stages.ts`; CLI `cli.ts`; API `server.ts`; test `acceptance.ts`.

## Run / verify
- `pnpm acceptance` — headless full-pipeline + compliance assertions (the fast confidence check).
- `pnpm server` (:8787) + `pnpm dashboard` (:5173) for the manual flow.
- `pnpm typecheck` (backend) / `pnpm --filter @storefront/dashboard exec tsc --noEmit` (UI).

## Gotchas
- `better-sqlite3` native binding on Windows/OneDrive: if bindings missing after install, run
  `npx prebuild-install` inside its package dir. Build scripts are allow-listed via
  root `package.json` `pnpm.onlyBuiltDependencies`.
- Dates are pinned (`2026`) in a few places for deterministic mock audits/TTLs — see
  `core/src/audit.ts` and `builder.ts::addDays`.
- Background `pnpm server` gets reaped by the tool harness; test the API by starting + curling +
  killing within a single shell invocation.

## Status: Phase 1 complete & passing. Phases 2–4 not started (intentional stop point).
