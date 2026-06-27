import { useEffect, useState, useCallback } from 'react';
import { api, type Lead, type Health, type LeadStatus } from './api.js';

const STATUS_COLORS: Record<LeadStatus, string> = {
  discovered: 'bg-gray-200 text-gray-700',
  qualified: 'bg-blue-100 text-blue-700',
  demo_built: 'bg-violet-100 text-violet-700',
  ready: 'bg-amber-100 text-amber-800',
  contacted: 'bg-emerald-100 text-emerald-700',
  replied: 'bg-teal-100 text-teal-700',
  won: 'bg-green-200 text-green-800',
  lost: 'bg-gray-100 text-gray-400',
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
    <div className="min-h-screen">
      <header className="bg-[#15151b] text-white px-6 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-extrabold tracking-tight">Storefront</span>
          <span className="text-xs text-gray-400">{health?.config.senderBusiness}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {health &&
            Object.entries(health.adapters).map(([k, v]) => (
              <span
                key={k}
                className={`px-2 py-0.5 rounded-full font-mono ${v === 'live' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-200'}`}
                title={v === 'mock' ? 'Mock adapter — add an API key to go live' : 'Live adapter'}
              >
                {k}:{v}
              </span>
            ))}
          {health && (
            <span className="px-2 py-0.5 rounded-full bg-white/10 text-gray-200">
              cap {health.config.dailySendCap}/day · TTL {health.config.demoTtlDays}d
            </span>
          )}
        </div>
      </header>

      {/* Discovery bar */}
      <div className="px-6 py-3 bg-white border-b flex items-center gap-2 flex-wrap">
        <input
          className="border rounded px-3 py-1.5 text-sm"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="category"
        />
        <input
          className="border rounded px-3 py-1.5 text-sm w-56"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="location"
        />
        <button
          className="bg-teal-700 text-white text-sm rounded px-4 py-1.5 disabled:opacity-50"
          disabled={!!busy}
          onClick={() => act('discover', () => api.prospect(category, location))}
        >
          {busy === 'discover' ? 'Discovering…' : 'Run discovery + qualify'}
        </button>
        <div className="flex gap-1 ml-auto text-[11px]">
          {counts.filter((c) => c.n > 0).map((c) => (
            <span key={c.s} className={`px-2 py-0.5 rounded ${STATUS_COLORS[c.s]}`}>
              {c.s} {c.n}
            </span>
          ))}
        </div>
      </div>

      {toast && (
        <div className="px-6 py-2 bg-red-50 text-red-700 text-sm border-b border-red-200">{toast}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(360px,1fr)_minmax(440px,1.2fr)] gap-0">
        {/* Leads table */}
        <div className="border-r overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide sticky top-0">
              <tr>
                <th className="text-left px-4 py-2">Business</th>
                <th className="text-left px-2 py-2">Seg</th>
                <th className="text-right px-2 py-2">Score</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-gray-400">
                  No leads yet — run discovery above.
                </td></tr>
              )}
              {leads.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => setSelectedId(l.id)}
                  className={`cursor-pointer border-b hover:bg-teal-50/50 ${selectedId === l.id ? 'bg-teal-50' : ''}`}
                >
                  <td className="px-4 py-2">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-xs text-gray-400">{l.contact_email ?? l.phone ?? '—'}</div>
                  </td>
                  <td className="px-2 py-2">
                    {l.segment && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${l.segment === 'bad' ? 'bg-orange-100 text-orange-700' : 'bg-sky-100 text-sky-700'}`}>
                        {l.segment}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-600">{l.score.toFixed(1)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_COLORS[l.status]}`}>{l.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail / gates */}
        <div className="p-5">
          {!selected ? (
            <div className="text-gray-400 text-sm pt-10 text-center">Select a lead to review.</div>
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
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">{lead.name}</h2>
        <div className="text-sm text-gray-500">
          {lead.category} · {lead.address}
        </div>
        <div className="text-sm text-gray-500">
          {lead.phone} {lead.contact_email && <>· {lead.contact_email}</>}
          {lead.website_url && (
            <> · <a className="text-teal-700 underline" href={lead.website_url} target="_blank" rel="noreferrer">current site</a></>
          )}
        </div>
      </div>

      {lead.audit && (
        <div className="bg-white border rounded-lg p-3 text-sm">
          <div className="font-semibold mb-1">
            Site audit:{' '}
            <span className={lead.audit.verdict === 'poor' ? 'text-orange-700' : lead.audit.verdict === 'good' ? 'text-green-700' : 'text-gray-600'}>
              {lead.audit.verdict}
            </span>
            {lead.audit.performanceScore != null && <span className="text-gray-400"> · PageSpeed {lead.audit.performanceScore}</span>}
          </div>
          <ul className="list-disc ml-5 text-gray-600">
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
        <div className="text-sm text-sky-700 bg-sky-50 border border-sky-200 rounded-lg p-3">
          No-website lead — phone-first outreach (Phase 3). Email pipeline skips this segment.
        </div>
      )}

      {/* Demo preview */}
      {lead.demo?.demo_url && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Demo preview</div>
            <a className="text-xs text-teal-700 underline" href={lead.demo.demo_url} target="_blank" rel="noreferrer">
              open ↗
            </a>
          </div>
          <iframe
            title="demo"
            src={lead.demo.demo_url}
            className="w-full h-[460px] border rounded-lg bg-white"
          />
          <div className="text-[11px] text-gray-400">
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
        <div className="bg-white border rounded-lg p-3 text-sm space-y-2">
          <div className="font-semibold">
            Outreach email{' '}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{lead.message.status}</span>
          </div>
          <div className="text-gray-500"><span className="font-medium">Subject:</span> {lead.message.subject}</div>
          <pre className="whitespace-pre-wrap text-xs text-gray-700 bg-gray-50 rounded p-2 max-h-56 overflow-auto">{lead.message.body}</pre>

          {lead.message.status === 'draft' && (
            <GateCard n="C" title="Approve message" desc="Approval is required before sending. Sends remain capped + suppression-checked.">
              <Btn label="Approve message" busy={busy === `approve-${lead.id}`}
                onClick={() => act(`approve-${lead.id}`, () => api.approve(lead.id))} />
            </GateCard>
          )}

          {lead.message.status === 'approved' && (
            <div className="border-t pt-2 space-y-2">
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
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
              {sendResult && <div className="text-xs text-gray-700">{sendResult}</div>}
            </div>
          )}
        </div>
      )}

      {/* Tracker: manual status */}
      <div className="text-xs text-gray-500 flex items-center gap-2 pt-1">
        <span>Set status:</span>
        <select
          className="border rounded px-2 py-1"
          value={lead.status}
          onChange={(e) => act(`status-${lead.id}`, () => api.setStatus(lead.id, e.target.value as LeadStatus))}
        >
          {ALL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    </div>
  );
}

function GateCard({ n, title, desc, children }: { n: string; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="border-2 border-dashed border-teal-300 bg-teal-50/40 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <span className="bg-teal-700 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center">{n}</span>
        <div className="font-semibold text-sm">{title}</div>
      </div>
      <div className="text-xs text-gray-500 mt-1 mb-2 ml-8">{desc}</div>
      <div className="ml-8">{children}</div>
    </div>
  );
}

function Btn({ label, onClick, busy, danger }: { label: string; onClick: () => void; busy?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`text-sm rounded px-4 py-1.5 text-white disabled:opacity-50 ${danger ? 'bg-red-600' : 'bg-teal-700'}`}
    >
      {busy ? 'Working…' : label}
    </button>
  );
}
