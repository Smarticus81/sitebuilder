import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useScroll, useTransform } from 'framer-motion';
import { HeroCanvas } from './three/HeroScene.js';

const EASE = [0.16, 1, 0.3, 1] as const;

/* Scroll-reveal wrapper. `mount` animates immediately (for above-the-fold hero
   content, where whileInView's observer can miss elements already in view). */
function Reveal({
  children,
  delay = 0,
  y = 26,
  className,
  mount = false,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  mount?: boolean;
}) {
  const anim = mount
    ? { animate: { opacity: 1, y: 0 } }
    : { whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-80px' } };
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      {...anim}
      transition={{ duration: 0.7, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/* ---- tiny inline icon set (stroke = currentColor) ---- */
const iconProps = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const Icons = {
  radar: () => (
    <svg {...iconProps}><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 12l6-3" /><circle cx="12" cy="12" r="1.6" /><path d="M12 12a4 4 0 1 0 4 4" opacity=".5" /></svg>
  ),
  bolt: () => (
    <svg {...iconProps}><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>
  ),
  shield: () => (
    <svg {...iconProps}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>
  ),
  gauge: () => (
    <svg {...iconProps}><path d="M12 13a5 5 0 0 1 5-5" opacity=".5" /><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 13 3-2.5" /></svg>
  ),
  layers: () => (
    <svg {...iconProps}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" opacity=".55" /></svg>
  ),
  scroll: () => (
    <svg {...iconProps}><path d="M6 3h10a2 2 0 0 1 2 2v13a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5" /><path d="M9 7h6M9 11h6M9 15h4" /></svg>
  ),
};

const FEATURES = [
  { icon: Icons.radar, title: 'Legitimate discovery', body: 'Places API sourcing plus a read of the prospect’s own site. Every lead is scored and audited — never scraped from results pages.' },
  { icon: Icons.bolt, title: 'Demos build themselves', body: 'One approval spins up a live one-page demo on a temp subdomain that auto-expires. You pitch a working site, not a promise.' },
  { icon: Icons.shield, title: 'Compliant by construction', body: 'Every email carries a physical address and a working unsubscribe. Suppression is permanent and checked before each send.' },
  { icon: Icons.gauge, title: 'Capped & controlled', body: 'Daily send caps and a single hard-coded send gate mean no runaway blasts. Quality over volume, enforced in code.' },
  { icon: Icons.layers, title: 'Mock-first, live-ready', body: 'Runs entirely on mocks out of the box. Drop in an API key and each service quietly switches to live.' },
  { icon: Icons.scroll, title: 'Full audit trail', body: 'Every irreversible step is logged and timestamped. Nothing reaches a prospect without a human decision behind it.' },
];

const GATES = [
  { n: 'A', title: 'Approve & build', body: 'Discovery scores and audits each business. You confirm the fit — then a demo is generated on a temporary subdomain.', tag: 'Build gate' },
  { n: 'B', title: 'Review the draft', body: 'Demo looks right? Generate a personalized, CAN-SPAM-compliant outreach email. It is drafted, never sent.', tag: 'Outreach gate' },
  { n: 'C', title: 'Approve the send', body: 'The only path to the wire. Approved, un-suppressed, under the daily cap, compliance-valid — or it does not go out.', tag: 'Send gate' },
];

const STATS = [
  { k: '3', v: 'human gates', sub: 'non-bypassable' },
  { k: '0', v: 'auto-sends', sub: 'ever' },
  { k: '100%', v: 'CAN-SPAM', sub: 'in code' },
  { k: '1-click', v: 'live demo', sub: 'per lead' },
];

const MARQUEE = ['Hair salons', 'Barber shops', 'Auto detailing', 'Med spas', 'Dentists', 'Landscapers', 'Cafés', 'Law offices', 'Gyms', 'Contractors'];

export default function Landing() {
  const { scrollYProgress } = useScroll();
  const heroOpacity = useTransform(scrollYProgress, [0, 0.22], [1, 0.16]);
  const heroBlur = useTransform(scrollYProgress, [0, 0.22], ['blur(0px)', 'blur(3px)']);

  return (
    <div className="relative min-h-screen overflow-x-clip text-[#e6e8ef]">
      {/* Top scroll progress bar */}
      <motion.div
        style={{ scaleX: scrollYProgress }}
        className="fixed top-0 left-0 right-0 z-50 h-[3px] origin-left bg-gradient-to-r from-teal-300 via-teal-400 to-violet-500"
      />

      {/* Fixed background stack */}
      <div className="fixed inset-0 -z-10 bg-ink">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_-10%,rgba(45,212,191,0.18),transparent_60%)]" />
        <div className="absolute inset-0 bg-grid" />
        <motion.div style={{ opacity: heroOpacity, filter: heroBlur }} className="absolute inset-0">
          <HeroCanvas progress={scrollYProgress} />
        </motion.div>
        {/* ambient orbs */}
        <div className="animate-floaty absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-teal-500/10 blur-3xl" />
        <div className="animate-floaty absolute right-0 top-2/3 h-80 w-80 rounded-full bg-violet-500/10 blur-3xl" style={{ animationDelay: '2s' }} />
      </div>

      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-40">
        <nav className="glass mx-auto mt-3 flex max-w-6xl items-center justify-between rounded-2xl px-4 py-2.5 sm:px-5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-teal-300 to-teal-600 text-sm font-black text-ink neon-ring">S</span>
            <span className="text-[15px] font-extrabold tracking-tight">Storefront</span>
            <span className="hidden text-xs text-white/40 sm:inline">Web Studio</span>
          </div>
          <div className="hidden items-center gap-7 text-sm text-white/60 md:flex">
            <a href="#how" className="transition hover:text-white">How it works</a>
            <a href="#features" className="transition hover:text-white">Features</a>
            <a href="#trust" className="transition hover:text-white">Compliance</a>
          </div>
          <Link
            to="/app"
            className="neon-ring rounded-full bg-teal-400 px-4 py-1.5 text-sm font-semibold text-ink transition hover:bg-teal-300"
          >
            Open dashboard →
          </Link>
        </nav>
      </header>

      {/* HERO */}
      <section className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 text-center">
        {/* Legibility scrim so headline stays crisp over the glowing 3D core */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -z-[1] h-[520px] w-[820px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(6,7,10,0.82)_0%,rgba(6,7,10,0.55)_45%,transparent_72%)]" />
        <Reveal mount>
          <span className="glass inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-teal-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
            Local web-agency pipeline · human-gated, compliant
          </span>
        </Reveal>
        <Reveal mount delay={0.08}>
          <h1 className="mt-6 max-w-4xl text-balance text-5xl font-black leading-[1.05] tracking-tight sm:text-6xl md:text-7xl">
            Build the demo <span className="text-gradient">before</span> you pitch.
          </h1>
        </Reveal>
        <Reveal mount delay={0.16}>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-white/60">
            Storefront finds local businesses with weak or missing websites, auto-builds a live
            demo, and queues CAN-SPAM-compliant outreach — with a human approval gate at every
            irreversible step.
          </p>
        </Reveal>
        <Reveal mount delay={0.24}>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link to="/app" className="neon-glow rounded-full bg-teal-400 px-6 py-3 text-sm font-semibold text-ink transition hover:bg-teal-300">
              Open the dashboard
            </Link>
            <a href="#how" className="glass rounded-full px-6 py-3 text-sm font-semibold text-white/80 transition hover:text-white">
              See how it works
            </a>
          </div>
        </Reveal>

        {/* scroll cue */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/30"
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="7" y="3" width="10" height="18" rx="5" /><path d="M12 7v3" strokeLinecap="round" />
          </svg>
        </motion.div>
      </section>

      {/* MARQUEE / trust strip */}
      <section className="relative z-10 border-y border-white/5 bg-ink/40 py-5 backdrop-blur-sm">
        <div className="mb-3 text-center text-xs uppercase tracking-[0.2em] text-white/30">Built for main-street businesses</div>
        <div className="flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
          <div className="animate-marquee flex shrink-0 items-center gap-10 pr-10 text-lg font-semibold text-white/25">
            {[...MARQUEE, ...MARQUEE].map((m, i) => (
              <span key={i} className="whitespace-nowrap">{m}</span>
            ))}
          </div>
        </div>
      </section>

      {/* STATS */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {STATS.map((s, i) => (
            <Reveal key={s.v} delay={i * 0.08}>
              <div className="glass card-hover rounded-2xl p-6 text-center">
                <div className="text-4xl font-black text-gradient">{s.k}</div>
                <div className="mt-1 text-sm font-semibold">{s.v}</div>
                <div className="text-xs text-white/40">{s.sub}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS — three gates */}
      <section id="how" className="relative z-10 mx-auto max-w-6xl scroll-mt-24 px-6 py-20">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-4xl font-black tracking-tight sm:text-5xl">Three gates. <span className="text-gradient">Zero surprises.</span></h2>
          <p className="mt-4 text-white/55">A human decision stands between every irreversible step and the outside world.</p>
        </Reveal>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {GATES.map((g, i) => (
            <Reveal key={g.n} delay={i * 0.12}>
              <div className="glass card-hover relative h-full overflow-hidden rounded-3xl p-7">
                <div className="absolute -right-6 -top-8 text-[9rem] font-black leading-none text-white/[0.03]">{g.n}</div>
                <span className="neon-ring grid h-11 w-11 place-items-center rounded-xl bg-teal-400/10 text-lg font-black text-teal-300">{g.n}</span>
                <div className="mt-4 text-xs uppercase tracking-widest text-teal-300/70">{g.tag}</div>
                <h3 className="mt-1 text-xl font-bold">{g.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/55">{g.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="relative z-10 mx-auto max-w-6xl scroll-mt-24 px-6 py-20">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-4xl font-black tracking-tight sm:text-5xl">Everything the pitch needs,<br /><span className="text-gradient">nothing that puts you at risk.</span></h2>
        </Reveal>
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <Reveal key={f.title} delay={(i % 3) * 0.1}>
                <div className="glass card-hover h-full rounded-2xl p-6">
                  <span className="neon-ring grid h-11 w-11 place-items-center rounded-xl bg-teal-400/10 text-teal-300"><Icon /></span>
                  <h3 className="mt-4 text-lg font-bold">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">{f.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* COMPLIANCE / TRUST */}
      <section id="trust" className="relative z-10 mx-auto max-w-6xl scroll-mt-24 px-6 py-20">
        <div className="glass overflow-hidden rounded-3xl p-8 sm:p-12">
          <div className="grid items-center gap-10 md:grid-cols-2">
            <Reveal>
              <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Compliance isn’t a checkbox. <span className="text-gradient">It’s the code path.</span></h2>
              <p className="mt-4 text-white/55">
                There is exactly one route to the wire, and it hard-requires an approved, un-suppressed
                message under the daily cap with a valid physical address and working unsubscribe.
                No flag, no config, no rush can bypass it.
              </p>
              <div className="mt-6 flex flex-wrap gap-2 text-xs">
                {['CAN-SPAM valid', 'Permanent suppression', 'Physical address', 'Working unsubscribe', 'Daily cap', 'No auto-send'].map((t) => (
                  <span key={t} className="rounded-full border border-teal-400/25 bg-teal-400/5 px-3 py-1 text-teal-200">{t}</span>
                ))}
              </div>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="rounded-2xl border border-white/10 bg-ink/60 p-5 font-mono text-[12.5px] leading-relaxed text-white/70">
                <div className="mb-2 flex gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-teal-400/70" />
                </div>
                <pre className="whitespace-pre-wrap"><span className="text-white/35">// core/sender.ts</span>{`
`}<span className="text-violet-300">function</span> <span className="text-teal-300">checkSendGate</span>(msg) {'{'}{`
`}{'  '}<span className="text-violet-300">if</span> (!msg.approved) <span className="text-violet-300">return</span> block;{`
`}{'  '}<span className="text-violet-300">if</span> (suppressed(msg.to)) <span className="text-violet-300">return</span> block;{`
`}{'  '}<span className="text-violet-300">if</span> (sentToday {'>='} cap) <span className="text-violet-300">return</span> block;{`
`}{'  '}<span className="text-violet-300">if</span> (!canSpamValid(msg)) <span className="text-violet-300">return</span> block;{`
`}{'  '}<span className="text-teal-300">return</span> send; <span className="text-white/35">// only path ✓</span>{`
`}{'}'}</pre>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 mx-auto max-w-4xl px-6 py-24 text-center">
        <Reveal>
          <div className="glass neon-glow rounded-[2rem] px-8 py-16">
            <h2 className="text-4xl font-black tracking-tight sm:text-5xl">Ready to see your pipeline?</h2>
            <p className="mx-auto mt-4 max-w-xl text-white/55">
              Run discovery, review demos, and walk each lead through the gates — all from one dashboard.
            </p>
            <Link to="/app" className="neon-glow mt-8 inline-block rounded-full bg-teal-400 px-8 py-3.5 text-sm font-bold text-ink transition hover:bg-teal-300">
              Open the dashboard →
            </Link>
          </div>
        </Reveal>
      </section>

      {/* FOOTER */}
      <footer className="relative z-10 border-t border-white/5 px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-sm text-white/40 sm:flex-row">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-teal-300 to-teal-600 text-xs font-black text-ink">S</span>
            <span className="font-semibold text-white/70">Storefront Web Studio</span>
          </div>
          <div>Quality over volume · Human-gated · CAN-SPAM compliant</div>
        </div>
      </footer>
    </div>
  );
}
