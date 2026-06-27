# Storefront — Local Web Agency Pipeline (Phase 1 MVP)

Find local businesses with no/weak websites, auto-build a polished demo site for
each from public data, and queue a personalized, **compliant** outreach email — with
**a human approval gate at every irreversible step**. Optimizes for quality and
conversion, not volume.

> **Phase 1 status: runnable end-to-end, today, with zero API keys.** Every external
> service sits behind an adapter that defaults to a deterministic **mock**. Add a real
> key to `.env` and that adapter goes **live** with no code change.

---

## Quickstart

```bash
pnpm install
cp .env.example .env          # already done if .env exists

# 1) Prove the whole pipeline + every compliance gate in one shot:
pnpm acceptance               # headless dry-run, asserts ~30 checks

# 2) Or drive it by hand:
pnpm server                   # worker API + serves demo previews  → :8787
pnpm dashboard                # React dashboard (separate terminal) → :5173
```

Open the dashboard, click **Run discovery + qualify**, then walk a lead through the
three gates: **Approve & build** → **Generate draft** → **Approve message** → **Send**.

> **Note (Windows / `better-sqlite3`):** if you see a "Could not locate the bindings
> file" error after install, run the prebuilt-binary fetch once:
> `cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx prebuild-install`.

---

## CLI (each stage is independent + resumable)

```bash
pnpm prospect --category "hair salon" --location "Fort Worth, TX"
pnpm qualify                  # segments + scores; STOPS at Gate A
pnpm build   [--limit 5]      # builds demos for 'bad'-segment leads (Gate A)
pnpm draft   [--limit 5]      # compliant email drafts (Gate B) — never sends
pnpm approve all              # or: approve <leadId>   (Gate C: human approval)
pnpm send    --dry-run        # runs ALL checks, sends nothing
pnpm send                     # sends ONLY approved msgs; capped + suppression-checked
pnpm status                   # pipeline counts + recent audit events
pnpm reset                    # wipe the local DB
```

---

## How the three gates are enforced

| Gate | Where | Mechanism (non-bypassable) |
|---|---|---|
| **A** — before a demo is built | after qualify | Building is an explicit per-lead action (dashboard button / `build` command). `none`-segment leads are excluded from the email pipeline. |
| **B** — before outreach-ready | after build | Drafting is an explicit action. Output is always status `draft`. |
| **C** — before ANY send | before send | `checkSendGate()` is the **only** path to the wire. It hard-requires: message `approved` by a human, recipient **not suppressed**, **daily cap** not exceeded, and full **CAN-SPAM** validation (address + working unsubscribe + honest subject). `send` ignores any message that isn't `approved`. There is **no auto-send path** anywhere in the code. |

Every state change and every send/block is written to the `events` audit log.

---

## CAN-SPAM, in code (not just notes)

- Every email body is stamped with the configured **physical mailing address** and a
  **working one-click unsubscribe** link (`/unsubscribe`, HMAC-tokened).
- Unsubscribes are written to the **permanent** `suppression` table, checked before
  every send.
- **Daily send cap** (`DAILY_SEND_CAP`, default 15) enforced in `checkSendGate`.
- Demos carry a *"Demo preview prepared by …"* banner and a `unpublish_at` TTL.
- No autonomous card charges or domain purchases (Phase 3 generates approval links).

---

## Architecture

```
pnpm monorepo
├── packages/
│   ├── db        SQLite schema + typed repositories + audit log
│   ├── places    Google Places adapter  (mock: Fort Worth salon fixtures)
│   ├── llm        Anthropic adapter      (mock: deterministic copy)
│   ├── email      Resend adapter         (mock: writes to data/outbox)
│   └── core       config · audit · qualifier · builder · template · deploy
│                  · outreach · compliance · sender · context
└── apps/
    ├── worker     CLI (stages) + Express API + acceptance dry-run
    └── dashboard  React 19 + Vite + Tailwind v4 (leads table, demo iframe, gates)

Prospector → Qualifier → [GATE A] → Builder → [GATE B] → Drafts → [GATE C] → Send → Tracker
```

Pipeline statuses: `discovered → qualified → demo_built → ready → contacted → replied → won → lost`.

---

## Going live (drop in keys, no code change)

Set any of these in `.env`; the matching adapter switches from mock → live:

| Key | Activates |
|---|---|
| `GOOGLE_PLACES_API_KEY` | real discovery via Places `searchText` |
| `PAGESPEED_API_KEY` | real performance score in the site audit |
| `ANTHROPIC_API_KEY` | real LLM demo copy + outreach drafting (`claude-opus-4-8`) |
| `VERCEL_TOKEN` | real preview deploys (else demos render locally to `demos-out/`) |
| `EMAIL_PROVIDER=resend` + `EMAIL_PROVIDER_API_KEY` | real sending |

Always required for compliant mail: `SENDER_NAME`, `SENDER_BUSINESS`, `MAILING_ADDRESS`,
`REPLY_TO`, `FROM_DOMAIN` (use a **dedicated sending subdomain** with SPF/DKIM/DMARC —
not the parent's primary domain).

---

## What works vs. what's stubbed (honest status)

**Works end-to-end (mock-first):**
- Discovery → qualify (segment + score + email scrape), good sites auto-dropped.
- One polished salon/barber template; LLM copy + review mining; local demo deploy.
- All three gates; CAN-SPAM stamping; suppression; daily cap; full audit log.
- Dashboard (table, demo preview iframe, gate buttons, manual status) + CLI + acceptance test.

**Stubbed / lightly wired (live paths exist, exercised only in mock):**
- `GooglePlacesProvider`, `AnthropicLlmProvider`, `ResendEmailProvider`,
  `VercelDeployProvider` are implemented against real APIs but have **not** been run
  against live endpoints here.
- Vercel custom-subdomain aliasing + `unpublish` are placeholders (preview URL is returned).
- PageSpeed is the only live audit signal; richer Lighthouse checks are TODO.

**Not built yet (later phases, by design — stopped after Phase 1 per spec):**
- Phase 2: 4–5 templates, follow-up sequencing, auto-unpublish job, reply detection.
- Phase 3: `none`-segment call scripts + "text the demo", close/checkout, domain requests.
- Phase 4: A/B testing, analytics (MRR, reply/close rates).

See `GOAL.md`-style spec for the full phase plan.
