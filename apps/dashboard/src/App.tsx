import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api, type Lead, type Health, type LeadStatus } from './api.js';

const STATUS_COLORS: Record<LeadStatus, string> = {
  discovered: 'bg-white/5 text-white/50 border-white/10',
  qualified: 'bg-sky-400/10 text-sky-300 border-sky-400/20',
  demo_built: 'bg-violet-400/10 text-violet-300 border-violet-400/20',
  ready: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  contacted: 'bg-teal-400/10 text-teal-300 border-teal-400/20',
  replied: 'bg-cyan-400/10 text-cyan-300 border-cyan-400/20',
  won: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30',
  lost: 'bg-white/5 text-white/30 border-white/10',
};

const ALL_STATUSES: LeadStatus[] = [
  'discovered', 'qualified', 'demo_built', 'ready', 'contacted', 'replied', 'won', 'lost',
];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [category, setCategory] = useState('hair salon');
  const [location, setLocation] = useState('Fort Worth, TX');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [h, l] = await Promise.all([api.health(), api.leads()]);
    setHealth(h);
    setLeads(l);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setToast(String(e)));
  }, [refresh]);

  const selected = leads.find((l) => l.id === selectedId) ?? null;

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setToast(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const counts = ALL_STATUSES.map((s) => ({ s, n: leads.filter((l) => l.status === s).length }));

  return (
    <div className="relative min-h-screen text-[#e6e8ef]">
      {/* ambient background */}
      <div className="fixed inset-0 -z-10 bg-ink">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(45,212,191,0.12),transparent_60%)]" />
        <div className="absolute inset-0 bg-grid opacity-60" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-white/8 bg-ink/70 px-6 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5 transition hover:opacity-80">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-teal-300 to-teal-600 text-sm font-black text-ink neon-ring">S</span>
            <span className="text-lg font-extrabold tracking-tight">Storefront</span>
          </Link>
          <span className="text-xs text-white/35">{health?.config.senderBusiness}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {health &&
            Object.entries(health.adapters).map(([k, v]) => (
              <span
                key={k}
                className={`rounded-full px-2 py-0.5 font-mono ${v === 'live' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/15 text-amber-200'}`}
                title={v === 'mock' ? 'Mock adapter — add an API key to go live' : 'Live adapter'}
              >
                {k}:{v}
              </span>
            ))}
          {health && (
            <span className="rounded-full bg-white/8 px-2 py-0.5 text-white/60">
              cap {health.config.dailySendCap}/day · TTL {health.config.demoTtlDays}d
            </span>
          )}
        </div>
      </header>

      {/* Discovery bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/8 bg-white/[0.02] px-6 py-3 backdrop-blur-sm">
        <input
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 outline-none transition focus:border-teal-400/50 focus:bg-white/[0.07]"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="category"
        />
        <input
          className="w-56 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-white/30 outline-none transition focus:border-teal-400/50 focus:bg-white/[0.07]"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="location"
        />
        <button
          className="neon-ring rounded-lg bg-teal-400 px-4 py-1.5 text-sm font-semibold text-ink transition hover:bg-teal-300 disabled:opacity-50"
          disabled={!!busy}
          onClick={() => act('discover', () => api.prospect(category, location))}
        >
          {busy === 'discover' ? 'Discovering…' : 'Run discovery + qualify'}
        </button>
        <div className="ml-auto flex flex-wrap gap-1 text-[11px]">
          {counts.filter((c) => c.n > 0).map((c) => (
            <span key={c.s} className={`rounded-full border px-2 py-0.5 ${STATUS_COLORS[c.s]}`}>
              {c.s} {c.n}
            </span>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-sm text-red-300"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(360px,1fr)_minmax(440px,1.2fr)]">
        {/* Leads table */}
        <div className="overflow-auto border-r border-white/8">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-ink/80 text-xs uppercase tracking-wide text-white/40 backdrop-blur">
              <tr className="border-b border-white/8">
                <th className="px-4 py-2.5 text-left font-medium">Business</th>
                <th className="px-2 py-2.5 text-left font-medium">Seg</th>
                <th className="px-2 py-2.5 text-right font-medium">Score</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-12 text-center text-white/30">
                  No leads yet — run discovery above.
                </td></tr>
              )}
              {leads.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => setSelectedId(l.id)}
                  className={`cursor-pointer border-b border-white/5 transition-colors hover:bg-teal-400/[0.06] ${selectedId === l.id ? 'bg-teal-400/10 shadow-[inset_2px_0_0_0_#2dd4bf]' : ''}`}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-white/90">{l.name}</div>
                    <div className="text-xs text-white/35">{l.contact_email ?? l.phone ?? '—'}</div>
                  </td>
                  <td className="px-2 py-2.5">
                    {l.segment && (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${l.segment === 'bad' ? 'bg-orange-400/15 text-orange-300' : 'bg-sky-400/15 text-sky-300'}`}>
                        {l.segment}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-white/60">{l.score.toFixed(1)}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${STATUS_COLORS[l.status]}`}>{l.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail / gates */}
        <div className="p-5">
          {!selected ? (
            <div className="pt-10 text-center text-sm text-white/30">Select a lead to review.</div>
          ) : (
            <Detail key={selected.id} lead={selected} busy={busy} act={act} />
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({
  lead,
  busy,
  act,
}: {
  lead: Lead;
  busy: string | null;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [dryRun, setDryRun] = useState(true);
  const [sendResult, setSendResult] = useState<string | null>(null);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-4"
    >
      <div>
        <h2 className="text-xl font-bold text-white">{lead.name}</h2>
        <div className="text-sm text-white/50">
          {lead.category} · {lead.address}
        </div>
        <div className="text-sm text-white/50">
          {lead.phone} {lead.contact_email && <>· {lead.contact_email}</>}
          {lead.website_url && (
            <> · <a className="text-teal-300 underline decoration-teal-400/40 underline-offset-2 hover:text-teal-200" href={lead.website_url} target="_blank" rel="noreferrer">current site</a></>
          )}
        </div>
      </div>

      {lead.audit && (
        <div className="glass rounded-xl p-3 text-sm">
          <div className="mb-1 font-semibold">
            Site audit:{' '}
            <span className={lead.audit.verdict === 'poor' ? 'text-orange-300' : lead.audit.verdict === 'good' ? 'text-emerald-300' : 'text-white/60'}>
              {lead.audit.verdict}
            </span>
            {lead.audit.performanceScore != null && <span className="text-white/35"> · PageSpeed {lead.audit.performanceScore}</span>}
          </div>
          <ul className="ml-5 list-disc text-white/55">
            {lead.audit.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}

      {/* GATE A */}
      {lead.status === 'qualified' && lead.segment === 'bad' && (
        <GateCard
          n="A"
          title="Approve this lead → build the demo"
          desc="Confirm this is a good fit. Building generates a one-page demo on a temp subdomain."
        >
          <Btn label="Approve & build demo" busy={busy === `build-${lead.id}`}
            onClick={() => act(`build-${lead.id}`, () => api.build(lead.id))} />
        </GateCard>
      )}
      {lead.status === 'qualified' && lead.segment === 'none' && (
        <div className="rounded-xl border border-sky-400/20 bg-sky-400/5 p-3 text-sm text-sky-200">
          No-website lead — phone-first outreach (Phase 3). Email pipeline skips this segment.
        </div>
      )}

      {/* Demo preview */}
      {lead.demo?.demo_url && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Demo preview</div>
            <a className="text-xs text-teal-300 underline decoration-teal-400/40 underline-offset-2 hover:text-teal-200" href={lead.demo.demo_url} target="_blank" rel="noreferrer">
              open ↗
            </a>
          </div>
          <iframe
            title="demo"
            src={previewSrc(lead.demo.demo_url)}
            className="h-[460px] w-full rounded-xl border border-white/10 bg-white"
          />
          <div className="text-[11px] text-white/35">
            {lead.demo.subdomain} · auto-unpublishes {lead.demo.unpublish_at?.slice(0, 10)}
          </div>
        </div>
      )}

      {/* GATE B */}
      {lead.status === 'demo_built' && (
        <GateCard n="B" title="Demo looks good → generate outreach draft"
          desc="Creates a personalized, CAN-SPAM-compliant email draft. It is NOT sent.">
          <Btn label="Generate outreach draft" busy={busy === `draft-${lead.id}`}
            onClick={() => act(`draft-${lead.id}`, () => api.draft(lead.id))} />
        </GateCard>
      )}

      {/* Message + GATE C */}
      {lead.message && (
        <div className="glass space-y-2 rounded-xl p-3 text-sm">
          <div className="font-semibold">
            Outreach email{' '}
            <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-white/60">{lead.message.status}</span>
          </div>
          <div className="text-white/50"><span className="font-medium text-white/70">Subject:</span> {lead.message.subject}</div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-ink/60 p-2 text-xs text-white/70">{lead.message.body}</pre>

          {lead.message.status === 'draft' && (
            <GateCard n="C" title="Approve message" desc="Approval is required before sending. Sends remain capped + suppression-checked.">
              <Btn label="Approve message" busy={busy === `approve-${lead.id}`}
                onClick={() => act(`approve-${lead.id}`, () => api.approve(lead.id))} />
            </GateCard>
          )}

          {lead.message.status === 'approved' && (
            <div className="space-y-2 border-t border-white/8 pt-2">
              <label className="flex items-center gap-2 text-xs text-white/60">
                <input type="checkbox" className="accent-teal-400" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                Dry run (run all checks, don't actually send)
              </label>
              <Btn
                label={dryRun ? 'Dry-run send' : 'Send for real'}
                danger={!dryRun}
                busy={busy === `send-${lead.id}`}
                onClick={() =>
                  act(`send-${lead.id}`, async () => {
                    const r = await api.send(lead.id, dryRun);
                    setSendResult(
                      r.gate.ok
                        ? r.dryRun
                          ? `✓ Would send (${r.gate.sentToday}/${r.gate.cap} today). Nothing sent.`
                          : '✓ Sent.'
                        : `✗ Blocked: ${r.gate.reasons.join('; ')}`,
                    );
                  })
                }
              />
              {sendResult && <div className="text-xs text-white/70">{sendResult}</div>}
            </div>
          )}
        </div>
      )}

      {/* Tracker: manual status */}
      <div className="flex items-center gap-2 pt-1 text-xs text-white/50">
        <span>Set status:</span>
        <select
          className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-white outline-none transition focus:border-teal-400/50"
          value={lead.status}
          onChange={(e) => act(`status-${lead.id}`, () => api.setStatus(lead.id, e.target.value as LeadStatus))}
        >
          {ALL_STATUSES.map((s) => <option key={s} value={s} className="bg-surface text-white">{s}</option>)}
        </select>
      </div>
    </motion.div>
  );
}

function GateCard({ n, title, desc, children }: { n: string; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-teal-400/25 bg-teal-400/[0.04] p-3 neon-ring">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-400 text-xs font-bold text-ink">{n}</span>
        <div className="text-sm font-semibold text-white">{title}</div>
      </div>
      <div className="mb-2 ml-8 mt-1 text-xs text-white/50">{desc}</div>
      <div className="ml-8">{children}</div>
    </div>
  );
}

/**
 * Demos deployed locally are stored with an absolute http://localhost:8787 URL.
 * On a phone, "localhost" is the phone itself, so rewrite local demo URLs to a
 * same-origin path that goes through Vite's /demos proxy. Live (e.g. Vercel)
 * URLs on a real host are left untouched.
 */
function previewSrc(url: string | null): string {
  if (!url) return '';
  try {
    const u = new URL(url, window.location.origin);
    if (/^(localhost|127\.|0\.0\.0\.0)/.test(u.hostname)) return u.pathname + u.search;
    return url;
  } catch {
    return url;
  }
}

function Btn({ label, onClick, busy, danger }: { label: string; onClick: () => void; busy?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${danger ? 'bg-red-500 text-white hover:bg-red-400' : 'bg-teal-400 text-ink hover:bg-teal-300'}`}
    >
      {busy ? 'Working…' : label}
    </button>
  );
}
