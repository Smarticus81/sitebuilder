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
  cancelSequencesForEmail,
  parseResendWebhook,
  handleInboundEvent,
  verifyResendSignature,
  runUnpublishJob,
  draftCallScript,
  draftDemoSms,
  approveSms,
  sendApprovedSms,
  recordSmsOptOut,
} from '@storefront/core';
import {
  prospect,
  qualifyAll,
  buildOne,
  draftOne,
  approveLeadMessage,
  sendOneMessage,
  draftSequenceForLead,
  approveSequenceById,
  runSequencesJob,
} from './stages.js';

const ctx = createContext();
const app = express();

// Resend webhook FIRST, with the raw body preserved for signature checks.
// (express.json() below would otherwise consume the stream.)
app.post('/webhooks/resend', express.raw({ type: '*/*' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (secret) {
    const ok = verifyResendSignature(
      secret,
      {
        id: req.header('svix-id') ?? undefined,
        timestamp: req.header('svix-timestamp') ?? undefined,
        signature: req.header('svix-signature') ?? undefined,
      },
      raw,
    );
    if (!ok) return res.status(401).json({ error: 'invalid signature' });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  const evt = parseResendWebhook(payload as Parameters<typeof parseResendWebhook>[0]);
  if (!evt) return res.json({ ok: true, ignored: true });
  const result = handleInboundEvent(ctx.db, evt);
  res.json({ ok: true, ...result });
});

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

// ── Follow-up sequences (Phase 2) ────────────────────────────────────────────
app.post(
  '/api/leads/:id/sequence',
  wrap(async (req, res) => {
    const r = draftSequenceForLead(ctx, Number(req.params.id));
    res.json({ ok: true, sequence: r.sequence, messages: r.messages });
  }),
);

// Human gate: approving a sequence is an explicit operator action.
app.post(
  '/api/sequences/:id/approve',
  wrap(async (req, res) => {
    const by = req.body?.approvedBy ?? 'dashboard-user';
    const sequence = approveSequenceById(ctx, Number(req.params.id), by);
    res.json({ ok: true, sequence });
  }),
);

app.post(
  '/api/jobs/run-sequences',
  wrap(async (req, res) => {
    const dryRun = req.body?.dryRun === true;
    const r = await runSequencesJob(ctx, { dryRun });
    res.json(r);
  }),
);

app.post(
  '/api/jobs/unpublish',
  wrap(async (_req, res) => {
    const r = await runUnpublishJob(ctx);
    res.json(r);
  }),
);

// ── Phase 3: none-segment (call scripts + TCPA-gated SMS) ────────────────────
app.post(
  '/api/leads/:id/call-script',
  wrap(async (req, res) => {
    const lead = getLead(ctx.db, Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'not found' });
    const message = draftCallScript(ctx.db, ctx.config, lead);
    res.json({ ok: true, message });
  }),
);

app.post(
  '/api/leads/:id/sms',
  wrap(async (req, res) => {
    const lead = getLead(ctx.db, Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'not found' });
    const sms = draftDemoSms(ctx.db, ctx.config, lead);
    res.json({ ok: true, sms });
  }),
);

// Human gate: TCPA basis is REQUIRED and typed by the operator.
app.post(
  '/api/sms/:id/approve',
  wrap(async (req, res) => {
    const by = req.body?.approvedBy ?? 'dashboard-user';
    const basis = String(req.body?.tcpaBasis ?? '');
    const sms = approveSms(ctx.db, Number(req.params.id), by, basis);
    res.json({ ok: true, sms });
  }),
);

app.post(
  '/api/sms/:id/send',
  wrap(async (req, res) => {
    const dryRun = req.body?.dryRun === true;
    const outcome = await sendApprovedSms(ctx, Number(req.params.id), { dryRun });
    res.json(outcome);
  }),
);

// Twilio inbound webhook: STOP/UNSUBSCRIBE bodies opt the number out forever.
app.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res) => {
  const from = String(req.body?.From ?? '');
  const text = String(req.body?.Body ?? '').trim().toUpperCase();
  if (from && ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(text)) {
    recordSmsOptOut(ctx.db, from);
  }
  res.type('text/xml').send('<Response></Response>');
});

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
  cancelSequencesForEmail(ctx.db, email, 'recipient unsubscribed');
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
