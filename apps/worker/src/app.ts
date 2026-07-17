// The worker's HTTP app, as a factory so acceptance tests can exercise the
// real middleware stack (auth, rate limiting, webhooks) on an ephemeral port.
//
// Route security model:
//   PUBLIC:   /api/health, /api/login, /webhooks/* (signature-verified),
//             /unsubscribe, /approve/domain, /beacon/*, /demos/*, /proposals/*
//   PROTECTED (when DASHBOARD_PASSWORD is set): every other /api route.

import { resolve } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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
  type Context,
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
  createProposal,
  requestDomainPurchase,
  decideDomainRequest,
  closeLead,
  computeAnalytics,
  concludeExperiment,
  recordDemoView,
  authEnabled,
  checkPassword,
  issueToken,
  verifyToken,
  slog,
  alertOperator,
  sendDailyDigest,
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

// ── Simple in-memory rate limiter (per IP, sliding minute window) ────────────
function rateLimiter(maxPerMinute: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const windowStart = now - 60_000;
    const list = (hits.get(key) ?? []).filter((t) => t > windowStart);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) hits.clear(); // memory backstop
    if (list.length > maxPerMinute) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    next();
  };
}

export function buildApp(ctx: Context, env: NodeJS.ProcessEnv = process.env): Express {
  const app = express();
  app.set('trust proxy', 1);

  // Resend webhook FIRST, with the raw body preserved for signature checks.
  // (express.json() below would otherwise consume the stream.)
  app.post('/webhooks/resend', express.raw({ type: '*/*' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    const secret = env.RESEND_WEBHOOK_SECRET?.trim();
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
    handleInboundEvent(ctx.db, evt)
      .then((result) => res.json({ ok: true, ...result }))
      .catch((e) => {
        slog('error', 'webhook.resend.failed', { error: String(e) });
        res.status(500).json({ error: String(e) });
      });
  });

  app.use(express.json());
  app.use(rateLimiter(Number(env.API_RATE_LIMIT_PER_MINUTE ?? '120')));

  // Structured request logging for mutations (GETs stay quiet).
  app.use((req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      slog('info', 'http.request', { method: req.method, path: req.path });
    }
    next();
  });

  // CORS: permissive in dev; restricted to DASHBOARD_ORIGIN in production.
  const allowedOrigin = env.DASHBOARD_ORIGIN?.trim() || '*';
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', allowedOrigin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  });
  app.options('*', (_req, res) => res.sendStatus(204));

  // Serve locally-deployed demos so the dashboard preview iframe resolves offline.
  app.use('/demos', express.static(resolve(process.cwd(), 'demos-out')));
  // Proposal pages (Phase 3 close flow).
  app.use('/proposals', express.static(resolve(process.cwd(), 'proposals-out')));

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (e) {
        slog('error', 'http.error', { path: req.path, error: (e as Error).message });
        res.status(400).json({ error: (e as Error).message });
      }
    };

  // ── Auth (Phase E) ──────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    if (!authEnabled(env)) return res.json({ ok: true, token: null, authDisabled: true });
    const password = String(req.body?.password ?? '');
    if (!checkPassword(password, env)) {
      slog('warn', 'auth.failed_login', {});
      return res.status(401).json({ error: 'invalid password' });
    }
    res.json({ ok: true, token: issueToken(env) });
  });

  // Every /api route below this middleware requires a valid session token
  // whenever a dashboard password is configured. /api/health stays public
  // for deploy health checks.
  app.use('/api', (req, res, next) => {
    if (!authEnabled(env)) return next();
    if (req.path === '/health' || req.path === '/login') return next();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token && verifyToken(token, env)) return next();
    res.status(401).json({ error: 'authentication required' });
  });

  // ── Meta ────────────────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      adapters: adapterModes(ctx),
      auth: authEnabled(env),
      config: {
        senderBusiness: ctx.config.senderBusiness,
        dailySendCap: ctx.config.dailySendCap,
        demoTtlDays: ctx.config.demoTtlDays,
        mailingAddressSet: !!ctx.config.mailingAddress,
      },
    });
  });

  async function leadView(id: number) {
    const lead = await getLead(ctx.db, id);
    if (!lead) return null;
    const demo = await getDemoByLead(ctx.db, id);
    const message = await getMessageByLead(ctx.db, id);
    return {
      ...lead,
      audit: lead.audit_json ? JSON.parse(lead.audit_json) : null,
      demo: demo ?? null,
      message: message ?? null,
    };
  }

  app.get(
    '/api/leads',
    wrap(async (_req, res) => {
      const leads = await listLeads(ctx.db);
      res.json(await Promise.all(leads.map((l) => leadView(l.id))));
    }),
  );

  app.get(
    '/api/leads/:id',
    wrap(async (req, res) => {
      const view = await leadView(Number(req.params.id));
      if (!view) return res.status(404).json({ error: 'not found' });
      res.json({ ...view, events: await listEvents(ctx.db, Number(req.params.id)) });
    }),
  );

  app.get('/api/events', wrap(async (_req, res) => res.json(await listEvents(ctx.db))));
  app.get('/api/suppression', wrap(async (_req, res) => res.json(await listSuppression(ctx.db))));

  // ── Phase 4: analytics + A/B ────────────────────────────────────────────────
  app.get('/api/analytics', wrap(async (_req, res) => res.json(await computeAnalytics(ctx.db))));

  // Human-only: record the winning variant (reporting never auto-promotes).
  app.post(
    '/api/experiments/:name/conclude',
    wrap(async (req, res) => {
      const winner = String(req.body?.winner ?? '');
      const by = String(req.body?.concludedBy ?? 'dashboard-user');
      await concludeExperiment(ctx.db, String(req.params.name), winner, by);
      res.json({ ok: true });
    }),
  );

  // 1px demo-view beacon (image-only tracking; templates stay script-free).
  const BEACON_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  app.get('/beacon/demo/:slug', (req, res) => {
    void recordDemoView(ctx.db, String(req.params.slug)).catch(() => undefined);
    res.type('image/gif').send(BEACON_GIF);
  });

  // ── Discovery ───────────────────────────────────────────────────────────────
  app.post(
    '/api/prospect',
    wrap(async (req, res) => {
      const { category = 'hair salon', location = 'Fort Worth, TX', limit } = req.body ?? {};
      const r = await prospect(ctx, { category, location, limit });
      const q = await qualifyAll(ctx);
      res.json({ prospect: r, qualify: q });
    }),
  );

  // ── Gate A: build demo ──────────────────────────────────────────────────────
  app.post(
    '/api/leads/:id/build',
    wrap(async (req, res) => {
      const demo = await buildOne(ctx, Number(req.params.id));
      res.json({ ok: true, demo });
    }),
  );

  // ── Gate B: generate outreach draft ─────────────────────────────────────────
  app.post(
    '/api/leads/:id/draft',
    wrap(async (req, res) => {
      const message = await draftOne(ctx, Number(req.params.id));
      res.json({ ok: true, message });
    }),
  );

  // ── Gate C: approve + send ──────────────────────────────────────────────────
  app.post(
    '/api/leads/:id/approve',
    wrap(async (req, res) => {
      const by = req.body?.approvedBy ?? 'dashboard-user';
      const message = await approveLeadMessage(ctx, Number(req.params.id), by);
      res.json({ ok: true, message });
    }),
  );

  app.post(
    '/api/leads/:id/send',
    wrap(async (req, res) => {
      const dryRun = req.body?.dryRun === true;
      const msg = await getMessageByLead(ctx.db, Number(req.params.id));
      if (!msg) return res.status(400).json({ error: 'no message for lead' });
      const outcome = await sendOneMessage(ctx, msg.id, { dryRun });
      if (!outcome.sent && !outcome.dryRun && outcome.error) {
        void alertOperator(`Storefront: send failed for lead ${msg.lead_id}: ${outcome.error}`, env);
      }
      res.json(outcome);
    }),
  );

  // ── Follow-up sequences (Phase 2) ───────────────────────────────────────────
  app.post(
    '/api/leads/:id/sequence',
    wrap(async (req, res) => {
      const r = await draftSequenceForLead(ctx, Number(req.params.id));
      res.json({ ok: true, sequence: r.sequence, messages: r.messages });
    }),
  );

  // Human gate: approving a sequence is an explicit operator action.
  app.post(
    '/api/sequences/:id/approve',
    wrap(async (req, res) => {
      const by = req.body?.approvedBy ?? 'dashboard-user';
      const sequence = await approveSequenceById(ctx, Number(req.params.id), by);
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

  app.post(
    '/api/jobs/digest',
    wrap(async (_req, res) => {
      const digest = await sendDailyDigest(ctx.db, env);
      res.json({ ok: true, digest });
    }),
  );

  // ── Phase 3: none-segment (call scripts + TCPA-gated SMS) ───────────────────
  app.post(
    '/api/leads/:id/call-script',
    wrap(async (req, res) => {
      const lead = await getLead(ctx.db, Number(req.params.id));
      if (!lead) return res.status(404).json({ error: 'not found' });
      const message = await draftCallScript(ctx.db, ctx.config, lead);
      res.json({ ok: true, message });
    }),
  );

  app.post(
    '/api/leads/:id/sms',
    wrap(async (req, res) => {
      const lead = await getLead(ctx.db, Number(req.params.id));
      if (!lead) return res.status(404).json({ error: 'not found' });
      const sms = await draftDemoSms(ctx.db, ctx.config, lead);
      res.json({ ok: true, sms });
    }),
  );

  // Human gate: TCPA basis is REQUIRED and typed by the operator.
  app.post(
    '/api/sms/:id/approve',
    wrap(async (req, res) => {
      const by = req.body?.approvedBy ?? 'dashboard-user';
      const basis = String(req.body?.tcpaBasis ?? '');
      const sms = await approveSms(ctx.db, Number(req.params.id), by, basis);
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
      void recordSmsOptOut(ctx.db, from).catch(() => undefined);
    }
    res.type('text/xml').send('<Response></Response>');
  });

  // ── Phase 3: close & convert ────────────────────────────────────────────────
  app.post(
    '/api/leads/:id/proposal',
    wrap(async (req, res) => {
      const lead = await getLead(ctx.db, Number(req.params.id));
      if (!lead) return res.status(404).json({ error: 'not found' });
      const proposal = await createProposal(ctx, lead);
      res.json({ ok: true, proposal });
    }),
  );

  app.post(
    '/api/leads/:id/domain-request',
    wrap(async (req, res) => {
      const lead = await getLead(ctx.db, Number(req.params.id));
      if (!lead) return res.status(404).json({ error: 'not found' });
      const domain = String(req.body?.domain ?? '');
      const by = String(req.body?.requestedBy ?? 'dashboard-user');
      const r = await requestDomainPurchase(ctx.db, lead, domain, by);
      res.json({ ok: true, ...r });
    }),
  );

  // The human clicks the approval link — this only RECORDS the decision.
  app.get('/approve/domain', async (req, res) => {
    const token = String(req.query.token ?? '');
    const decision = String(req.query.decision ?? '');
    if (!token || (decision !== 'approve' && decision !== 'decline')) {
      return res.status(400).send('Invalid approval link.');
    }
    try {
      const r = await decideDomainRequest(
        ctx.db,
        token,
        decision === 'approve' ? 'approved' : 'declined',
        'approval-link',
      );
      res.send(
        `<html><body style="font-family:sans-serif;max-width:520px;margin:60px auto">` +
          `<h2>Domain request ${r.status}</h2><p><strong>${r.domain}</strong> is now ` +
          `<strong>${r.status}</strong>. ${
            r.status === 'approved'
              ? 'No purchase has been made — complete the registration manually with your registrar.'
              : 'No further action will be taken.'
          }</p></body></html>`,
      );
    } catch {
      res.status(404).send('Domain request not found.');
    }
  });

  app.post(
    '/api/leads/:id/close',
    wrap(async (req, res) => {
      const outcome = req.body?.outcome as 'won' | 'lost';
      const reason = String(req.body?.reason ?? '');
      if (outcome !== 'won' && outcome !== 'lost')
        return res.status(400).json({ error: 'outcome must be won|lost' });
      const lead = await closeLead(ctx.db, Number(req.params.id), outcome, reason);
      res.json({ ok: true, lead });
    }),
  );

  // ── Tracker: manual status update ───────────────────────────────────────────
  app.post(
    '/api/leads/:id/status',
    wrap(async (req, res) => {
      const status = req.body?.status as LeadStatus;
      const allowed: LeadStatus[] = [
        'discovered', 'qualified', 'demo_built', 'ready',
        'contacted', 'replied', 'won', 'lost',
      ];
      if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
      const lead = await setLeadStatus(ctx.db, Number(req.params.id), status);
      res.json({ ok: true, lead });
    }),
  );

  // ── Public: one-click unsubscribe (CAN-SPAM) ────────────────────────────────
  app.get('/unsubscribe', async (req, res) => {
    const email = String(req.query.email ?? '');
    const token = String(req.query.token ?? '');
    if (!email || !verifyUnsubscribeToken(email, token)) {
      return res.status(400).send('Invalid unsubscribe link.');
    }
    await recordUnsubscribe(ctx.db, email);
    await cancelSequencesForEmail(ctx.db, email, 'recipient unsubscribed');
    res
      .status(200)
      .send(
        `<html><body style="font-family:sans-serif;max-width:480px;margin:60px auto">` +
          `<h2>You're unsubscribed.</h2><p><strong>${email}</strong> has been permanently ` +
          `removed and will never be contacted again.</p></body></html>`,
      );
  });

  return app;
}
