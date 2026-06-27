import './env.js';
import { resolve } from 'node:path';
import express, { type Request, type Response } from 'express';
import {
  listLeads,
  getLead,
  getDemoByLead,
  getMessageByLead,
  listEvents,
  listSuppression,
  setLeadStatus,
  type LeadStatus,
} from '@storefront/db';
import {
  createContext,
  adapterModes,
  verifyUnsubscribeToken,
  recordUnsubscribe,
} from '@storefront/core';
import {
  prospect,
  qualifyAll,
  buildOne,
  draftOne,
  approveLeadMessage,
  sendOneMessage,
} from './stages.js';

const ctx = createContext();
const app = express();
app.use(express.json());

// Permissive CORS for the local Vite dashboard.
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

// Serve locally-deployed demos so the dashboard preview iframe resolves offline.
app.use('/demos', express.static(resolve(process.cwd(), 'demos-out')));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };

// ── Meta ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    adapters: adapterModes(ctx),
    config: {
      senderBusiness: ctx.config.senderBusiness,
      dailySendCap: ctx.config.dailySendCap,
      demoTtlDays: ctx.config.demoTtlDays,
      mailingAddressSet: !!ctx.config.mailingAddress,
    },
  });
});

function leadView(id: number) {
  const lead = getLead(ctx.db, id);
  if (!lead) return null;
  const demo = getDemoByLead(ctx.db, id);
  const message = getMessageByLead(ctx.db, id);
  return {
    ...lead,
    audit: lead.audit_json ? JSON.parse(lead.audit_json) : null,
    demo: demo ?? null,
    message: message ?? null,
  };
}

app.get('/api/leads', (_req, res) => {
  const leads = listLeads(ctx.db).map((l) => leadView(l.id));
  res.json(leads);
});

app.get('/api/leads/:id', (req, res) => {
  const view = leadView(Number(req.params.id));
  if (!view) return res.status(404).json({ error: 'not found' });
  res.json({ ...view, events: listEvents(ctx.db, Number(req.params.id)) });
});

app.get('/api/events', (_req, res) => res.json(listEvents(ctx.db)));
app.get('/api/suppression', (_req, res) => res.json(listSuppression(ctx.db)));

// ── Discovery ────────────────────────────────────────────────────────────────
app.post(
  '/api/prospect',
  wrap(async (req, res) => {
    const { category = 'hair salon', location = 'Fort Worth, TX', limit } = req.body ?? {};
    const r = await prospect(ctx, { category, location, limit });
    const q = await qualifyAll(ctx);
    res.json({ prospect: r, qualify: q });
  }),
);

// ── Gate A: build demo ───────────────────────────────────────────────────────
app.post(
  '/api/leads/:id/build',
  wrap(async (req, res) => {
    const demo = await buildOne(ctx, Number(req.params.id));
    res.json({ ok: true, demo });
  }),
);

// ── Gate B: generate outreach draft ──────────────────────────────────────────
app.post(
  '/api/leads/:id/draft',
  wrap(async (req, res) => {
    const message = await draftOne(ctx, Number(req.params.id));
    res.json({ ok: true, message });
  }),
);

// ── Gate C: approve + send ───────────────────────────────────────────────────
app.post(
  '/api/leads/:id/approve',
  wrap(async (req, res) => {
    const by = req.body?.approvedBy ?? 'dashboard-user';
    const message = approveLeadMessage(ctx, Number(req.params.id), by);
    res.json({ ok: true, message });
  }),
);

app.post(
  '/api/leads/:id/send',
  wrap(async (req, res) => {
    const dryRun = req.body?.dryRun === true;
    const msg = getMessageByLead(ctx.db, Number(req.params.id));
    if (!msg) return res.status(400).json({ error: 'no message for lead' });
    const outcome = await sendOneMessage(ctx, msg.id, { dryRun });
    res.json(outcome);
  }),
);

// ── Tracker: manual status update ────────────────────────────────────────────
app.post(
  '/api/leads/:id/status',
  wrap(async (req, res) => {
    const status = req.body?.status as LeadStatus;
    const allowed: LeadStatus[] = [
      'discovered', 'qualified', 'demo_built', 'ready',
      'contacted', 'replied', 'won', 'lost',
    ];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
    const lead = setLeadStatus(ctx.db, Number(req.params.id), status);
    res.json({ ok: true, lead });
  }),
);

// ── Public: one-click unsubscribe (CAN-SPAM) ─────────────────────────────────
app.get('/unsubscribe', (req, res) => {
  const email = String(req.query.email ?? '');
  const token = String(req.query.token ?? '');
  if (!email || !verifyUnsubscribeToken(email, token)) {
    return res.status(400).send('Invalid unsubscribe link.');
  }
  recordUnsubscribe(ctx.db, email);
  res
    .status(200)
    .send(
      `<html><body style="font-family:sans-serif;max-width:480px;margin:60px auto">` +
        `<h2>You're unsubscribed.</h2><p><strong>${email}</strong> has been permanently ` +
        `removed and will never be contacted again.</p></body></html>`,
    );
});

const port = Number(process.env.WORKER_PORT ?? 8787);
app.listen(port, () => {
  const modes = adapterModes(ctx);
  console.log(`\n  Storefront worker API → http://localhost:${port}`);
  console.log(`  adapters: ${Object.entries(modes).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`  demos served at /demos · dashboard talks to /api\n`);
});
