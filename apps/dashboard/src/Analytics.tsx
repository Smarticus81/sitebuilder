import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Analytics } from './api.js';

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.analytics().then(setData).catch((e) => setError(String(e)));
  useEffect(() => {
    load();
  }, []);

  async function conclude(name: string, winner: string) {
    if (!window.confirm(`Record "${winner}" as the winner of ${name}? This only records your choice — nothing is auto-promoted.`)) return;
    setBusy(true);
    try {
      await api.concludeExperiment(name, winner);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen text-[#e6e8ef]">
      <div className="fixed inset-0 -z-10 bg-ink">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(45,212,191,0.12),transparent_60%)]" />
        <div className="absolute inset-0 bg-grid opacity-60" />
      </div>

      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/8 bg-ink/70 px-6 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5 transition hover:opacity-80">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-teal-300 to-teal-600 text-sm font-black text-ink neon-ring">S</span>
            <span className="text-lg font-extrabold tracking-tight">Storefront</span>
          </Link>
          <span className="text-sm text-white/40">/ analytics</span>
        </div>
        <Link to="/app" className="rounded-lg bg-white/8 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/12">
          ← pipeline
        </Link>
      </header>

      {error && <div className="border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-sm text-red-300">{error}</div>}

      {!data ? (
        <div className="grid h-64 place-items-center text-white/30">Loading…</div>
      ) : (
        <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
          {/* Totals */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/40">Pipeline totals</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Tile label="Leads" value={String(data.totals.leads)} />
              <Tile label="Emails sent" value={String(data.totals.emailsSent)} />
              <Tile label="SMS sent" value={String(data.totals.smsSent)} />
              <Tile label="Opens" value={String(data.totals.opens)} />
              <Tile label="Replies" value={String(data.totals.replies)} />
              <Tile label="Demo views" value={String(data.totals.demoViews)} />
              <Tile label="Won" value={String(data.totals.won)} accent />
              <Tile label="Lost" value={String(data.totals.lost)} />
              <Tile label="Close rate" value={pct(data.totals.closeRate)} accent />
              <Tile label="One-time revenue" value={money(data.totals.oneTimeRevenueCents)} />
              <Tile label="MRR" value={money(data.totals.mrrCents)} accent />
            </div>
          </section>

          <Breakdown title="By template" rows={data.byTemplate} />
          <Breakdown title="By segment" rows={data.bySegment} />

          {/* Experiments */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/40">
              A/B experiments <span className="normal-case text-white/30">— winners are reported; adopting one is your call</span>
            </h2>
            <div className="space-y-4">
              {data.experiments.map((exp) => (
                <div key={exp.name} className="glass rounded-xl p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-white">{exp.name}</span>
                    <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-white/50">{exp.kind}</span>
                    {exp.winner ? (
                      <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-300">
                        concluded: {exp.winner} (by {exp.concludedBy})
                      </span>
                    ) : exp.leader ? (
                      <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-200">
                        current leader: {exp.leader}
                      </span>
                    ) : (
                      <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/40">not enough data</span>
                    )}
                  </div>
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-white/35">
                      <tr>
                        <th className="py-1.5 font-medium">Variant</th>
                        <th className="py-1.5 text-right font-medium">Leads</th>
                        <th className="py-1.5 text-right font-medium">Sent</th>
                        <th className="py-1.5 text-right font-medium">Replies</th>
                        <th className="py-1.5 text-right font-medium">Reply rate</th>
                        <th className="py-1.5 text-right font-medium">Won</th>
                        {!exp.winner && <th className="py-1.5 text-right font-medium" />}
                      </tr>
                    </thead>
                    <tbody>
                      {exp.variants.map((v) => (
                        <tr key={v.variant} className="border-t border-white/5">
                          <td className="py-1.5 font-mono text-white/80">{v.variant}</td>
                          <td className="py-1.5 text-right tabular-nums text-white/60">{v.leads}</td>
                          <td className="py-1.5 text-right tabular-nums text-white/60">{v.sent}</td>
                          <td className="py-1.5 text-right tabular-nums text-white/60">{v.replies}</td>
                          <td className="py-1.5 text-right tabular-nums text-white/60">{pct(v.replyRate)}</td>
                          <td className="py-1.5 text-right tabular-nums text-white/60">{v.won}</td>
                          {!exp.winner && (
                            <td className="py-1.5 text-right">
                              <button
                                disabled={busy}
                                onClick={() => conclude(exp.name, v.variant)}
                                className="rounded bg-white/8 px-2 py-0.5 text-[11px] text-white/60 transition hover:bg-teal-400/20 hover:text-teal-200 disabled:opacity-50"
                              >
                                declare winner
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[11px] uppercase tracking-wide text-white/40">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${accent ? 'text-teal-300' : 'text-white'}`}>{value}</div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: import('./api.js').BreakdownRow[] }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/40">{title}</h2>
      <div className="glass overflow-x-auto rounded-xl p-4">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-white/35">
            <tr>
              <th className="py-1.5 font-medium">{title.replace('By ', '')}</th>
              <th className="py-1.5 text-right font-medium">Leads</th>
              <th className="py-1.5 text-right font-medium">Demos</th>
              <th className="py-1.5 text-right font-medium">Emails sent</th>
              <th className="py-1.5 text-right font-medium">Replies</th>
              <th className="py-1.5 text-right font-medium">Won</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="py-4 text-center text-white/30">No data yet.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/5">
                <td className="py-1.5 font-mono text-white/80">{r.key}</td>
                <td className="py-1.5 text-right tabular-nums text-white/60">{r.leads}</td>
                <td className="py-1.5 text-right tabular-nums text-white/60">{r.demosBuilt}</td>
                <td className="py-1.5 text-right tabular-nums text-white/60">{r.emailsSent}</td>
                <td className="py-1.5 text-right tabular-nums text-white/60">{r.replies}</td>
                <td className="py-1.5 text-right tabular-nums text-white/60">{r.won}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
