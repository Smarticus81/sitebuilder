# Storefront — Local Web Agency Pipeline

Find local businesses with no/weak websites, auto-build a polished demo site for
each from public data, and run **compliant** outreach — with **a human approval
gate at every irreversible step**. Optimizes for quality and conversion, not volume.

> **Status: Phases 1–4 implemented + production hardening. Runnable end-to-end,
> today, with zero API keys.** Every external service sits behind an adapter that
> defaults to a deterministic **mock**. Add a real key to `.env` and that adapter
> goes **live** with no code change.

---

## Quickstart

```bash
pnpm install
cp .env.example .env          # required — the compliance gates need a sender identity

# 1) Prove the whole pipeline + every compliance gate in one shot:
pnpm acceptance               # headless dry-run, 151 assertions, zero keys needed

# 2) Or drive it by hand:
pnpm server                   # worker API + demos + proposals + webhooks → :8787
pnpm dashboard                # React dashboard (separate terminal)      → :5173
```

Open the dashboard, click **Run discovery + qualify**, then walk a lead through the
three gates: **Approve & build** → **Generate draft** → **Approve message** → **Send**.

> **Note (Windows / `better-sqlite3`):** if you see a "Could not locate the bindings
> file" error after install, run the prebuilt-binary fetch once:
> `cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx prebuild-install`.

---

## Commands

```bash
# Pipeline (each stage independent + resumable)
pnpm prospect --category "hair salon" --location "Fort Worth, TX"
pnpm qualify                  # segments + scores; STOPS at Gate A
pnpm build:demos [--limit 5]  # builds demos for approved leads (Gate A)
pnpm draft   [--limit 5]      # compliant email drafts (Gate B) — never sends
pnpm approve all|<leadId>     # Gate C: human approval
pnpm send    [--dry-run]      # sends ONLY approved msgs; capped + suppression-checked

# Phase 2–3 verbs
tsx apps/worker/src/cli.ts sequence draft <leadId>            # 2 follow-ups, ≥4d apart
tsx apps/worker/src/cli.ts sequence approve <seqId>           # human gate
tsx apps/worker/src/cli.ts sequence run [--dry-run]           # spaced, auto-canceling
tsx apps/worker/src/cli.ts callscript <leadId>                # phone-first leads
tsx apps/worker/src/cli.ts sms draft|approve|send …           # TCPA-gated (see below)
tsx apps/worker/src/cli.ts proposal <leadId>                  # page + payment link
tsx apps/worker/src/cli.ts domain-request <leadId> <domain>   # approval link, NO purchase
tsx apps/worker/src/cli.ts close <leadId> won|lost --reason "…"
tsx apps/worker/src/cli.ts unpublish                          # tear down expired demos

# Verification
pnpm acceptance               # 151 offline assertions (mock, zero keys)
pnpm doctor                   # env validation + live-adapter pings + SPF/DKIM/DMARC
pnpm smoke                    # live smoke per keyed adapter (skips without keys)
pnpm parity                   # SQLite↔Postgres driver parity (POSTGRES_URL optional)
pnpm typecheck && pnpm typecheck:ui
```

---

## How the gates are enforced

| Gate | Where | Mechanism (non-bypassable) |
|---|---|---|
| **A** — before a demo is built | after qualify | Building is an explicit per-lead action (dashboard button / CLI). |
| **B** — before outreach-ready | after build | Drafting is an explicit action. Output is always status `draft`. |
| **C** — before ANY email send | before send | `checkSendGate()` is the **only** path to the wire (verified: one `email.send()` call site in the codebase). It hard-requires: message `approved` by a human, recipient **not suppressed**, **daily cap** not exceeded, and full **CAN-SPAM** validation. |
| **Sequence gate** | before follow-ups | A human approves the whole sequence; the runner enforces max 2 follow-ups, ≥4-day spacing, auto-cancel on reply/unsubscribe — and each step passes `checkSendGate()` again at send time. |
| **SMS gate (TCPA)** | before any text | `checkSmsGate()` is the only path to the SMS wire: human approval **with a typed, documented consent basis**, permanent STOP opt-out list, daily SMS cap, 9am–8pm local quiet hours, mandatory opt-out language. |

Every state change and every send/block is written to the `events` audit log.

## Compliance, in code (not just notes)

- **CAN-SPAM**: every email body stamped with the physical mailing address + a
  working one-click unsubscribe (HMAC-tokened). Unsubscribes are **permanent**
  (suppression table) and checked before every send, including follow-ups.
  `List-Unsubscribe` headers included.
- **TCPA**: SMS approval requires a documented opt-in / prior-relationship basis;
  STOP replies (Twilio webhook) opt the number out forever; quiet hours enforced.
- **Daily caps**: email (`DAILY_SEND_CAP`, warm-up ramp can only lower it) and
  SMS (`SMS_DAILY_CAP`) enforced inside the gates.
- **No autonomous spend**: Stripe integration creates **payment links** only
  (customer-initiated payment; no charge API surface exists). Domain purchases
  are **requests** that mint an approve/decline link for the human — nothing in
  the codebase can buy a domain.
- Demos carry a *"Demo preview prepared by …"* banner and a real TTL
  (`unpublish_at`) that the unpublish job actually enforces.

---

## Architecture

```
pnpm monorepo
├── packages/
│   ├── db        Driver abstraction (SQLite default · Postgres for prod)
│   │             + async typed repositories + audit log + parity-tested schema
│   ├── net       hardened fetch: retries + jitter, timeouts, Retry-After,
│   │             secret-safe structured logging into events
│   ├── places    Google Places adapter   (mock: Fort Worth fixtures, 5 industries)
│   ├── llm       Anthropic adapter       (mock: deterministic copy per industry)
│   ├── email     Resend adapter          (mock: writes to data/outbox; idempotent sends)
│   ├── sms       Twilio adapter          (mock: writes to data/sms-outbox; never retried)
│   ├── payments  Stripe payment links    (mock: deterministic checkout URLs)
│   └── core      config · audit(Lighthouse) · qualifier · builder · template engine
│                 · deploy(Vercel alias+unpublish) · outreach · compliance · sender
│                 · sequences · replies · jobs · close · ab · analytics · auth
│                 · deliverability · observability
└── apps/
    ├── worker    CLI + Express API (app factory) + acceptance/parity/smoke/doctor
    └── dashboard React 19 + Vite + Tailwind v4 (pipeline, gates, analytics, login)

Prospector → Qualifier → [GATE A] → Builder → [GATE B] → Drafts → [GATE C] → Send
     ↘ none-segment → call script + [SMS GATE] → text-the-demo
Send → Tracker → replies/bounces (webhook) → [SEQUENCE GATE] → follow-ups → close
```

Pipeline statuses: `discovered → qualified → demo_built → ready → contacted → replied → won | lost` (closes record a reason).

## Going live (drop in keys, no code change)

| Key | Activates |
|---|---|
| `GOOGLE_PLACES_API_KEY` | real discovery via Places `searchText` (paginated) |
| `PAGESPEED_API_KEY` | full Lighthouse audit (perf, SEO, a11y, best practices) |
| `ANTHROPIC_API_KEY` | real LLM demo copy + outreach drafting |
| `VERCEL_TOKEN` (+`VERCEL_TEAM_ID`) | real deploys, custom-subdomain aliasing, real unpublish |
| `EMAIL_PROVIDER=resend` + `EMAIL_PROVIDER_API_KEY` | real sending (+`RESEND_WEBHOOK_SECRET` for replies/bounces/opens) |
| `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER` | real SMS (STOP webhook honored) |
| `STRIPE_API_KEY` | real payment links |
| `DATABASE_URL=postgres://…` | Postgres instead of SQLite (parity-tested) |

Always required for compliant mail: `SENDER_NAME`, `SENDER_BUSINESS`, `MAILING_ADDRESS`,
`REPLY_TO`, `FROM_DOMAIN` (a **dedicated sending subdomain** — `pnpm doctor` checks
SPF/DKIM/DMARC on it before you ever send).

---

## Honest status

**Implemented and covered by acceptance assertions (151 checks, zero keys):**
- Full pipeline incl. 5 industry templates, sequencing, reply/bounce/open detection,
  auto-unpublish, call scripts, TCPA-gated SMS, proposals + payment links, domain
  approval links, won/lost with reasons, analytics + A/B (human-concluded winners),
  auth + rate limiting, warm-up cap ramp, deliverability evaluators.
- Postgres driver **verified against a real PostgreSQL 16**: the whole acceptance
  suite and the parity suite pass on both backends.

**Implemented but requires operator keys/accounts to exercise (by design):**
- Live behavior of Places/Anthropic/Resend/Vercel/Twilio/Stripe/PageSpeed —
  `pnpm doctor` (pings + config checks) and `pnpm smoke` (one real minimal call per
  keyed adapter) are the operator's verification path. The smoke suite **never sends mail**.
- Reply detection needs the Resend inbound webhook pointed at `/webhooks/resend`
  (an IMAP poller can feed `handleInboundEvent` instead if no public URL is possible).

**Known limitations:**
- Single-operator auth (one shared password) — appropriate for the one-person parent
  model, not a team.
- Opens tracking depends on the provider's `email.opened` events; the digest goes to
  the alert webhook (never email — email stays exclusively behind `checkSendGate()`).
- In-process scheduler assumes one always-on worker instance (`ENABLE_SCHEDULER=0`
  + external cron on `/api/jobs/*` for multi-instance setups).

---

## Operator runbook (production)

1. **Provision**
   - Postgres (Neon/Supabase): create a DB, set `DATABASE_URL=postgres://…`.
     Migrating existing local data: set `POSTGRES_URL` and run `pnpm migrate:pg`
     (backs off if the target is non-empty). **Back up first.**
   - Worker: deploy the `Dockerfile` (Fly: `fly.toml`, Render: `render.yaml`).
     Set `NODE_ENV=production` — boot **refuses to start** without
     `DASHBOARD_PASSWORD`, `UNSUBSCRIBE_SECRET`, and a valid sender identity.
   - Dashboard: deploy `apps/dashboard` to Vercel (`vercel.json`), set
     `VITE_API_URL` to the worker URL, and set `DASHBOARD_ORIGIN` on the worker.
2. **Deliverability (before the first send)**
   - Use a dedicated subdomain (`outreach.yourdomain.com`) as `FROM_DOMAIN`.
   - Add it in Resend; publish the SPF/DKIM records Resend gives you + a `_dmarc`
     record. Run `pnpm doctor` until SPF/DKIM/DMARC are all ✓.
   - Configure the warm-up ramp: `SEND_WARMUP_START=<today>`,
     `SEND_WARMUP_RAMP=5,10,15,25`. The ramp only lowers the cap.
3. **Webhooks**
   - Resend → `https://worker/webhooks/resend` (set `RESEND_WEBHOOK_SECRET`).
   - Twilio inbound SMS → `https://worker/webhooks/twilio` (STOP handling).
4. **Observability**
   - Set `ALERT_WEBHOOK_URL` (Slack incoming webhook works): error alerts +
     daily digest arrive there. Logs are JSON lines on stdout.
5. **Daily operation**
   - Discovery/qualify → review leads → Gate A (build) → preview demo → Gate B
     (draft) → read every draft → Gate C (approve) → `send` (start with `--dry-run`).
   - Replies flip leads to `replied` automatically and cancel sequences.
   - Draft + approve a follow-up sequence per contacted lead; the scheduler
     sends when due — every step re-checked by the gate.
   - Close with `won`/`lost` + reason; `proposal <leadId>` generates the page +
     payment link; `domain-request` mints the approval link (you buy manually).
6. **Stop conditions (require a human decision, never automated)**
   - Raising `DAILY_SEND_CAP`, changing `checkSendGate()`, adding an outbound
     channel, production schema migrations, first live send.
