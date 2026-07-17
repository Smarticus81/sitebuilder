// Shared one-page template engine. One polished, self-contained skeleton
// (hero / about / services / gallery / reviews / visit) is themed per industry.
// All CSS is inlined and all images arrive as ready URLs (data URIs in mock
// mode), so rendered demos are fully offline-renderable, carry zero external
// scripts/stylesheets, and stay comfortably above Lighthouse 90 performance.

export interface TemplateData {
  businessName: string;
  city: string;
  category: string;
  tagline: string;
  about: string;
  services: string[];
  cta: string;
  phone: string | null;
  address: string | null;
  hours: string[];
  photos: string[];
  rating: number | null;
  reviewCount: number | null;
  reviews: string[];
  /** Footer attribution — mandatory, marks the page as a temporary demo. */
  demoFooter: string;
  /** Optional 1px view beacon (image only — templates stay script-free). */
  beaconUrl?: string;
}

export interface RenderOptions {
  /** A/B template variant: 'warm' swaps the theme's accent colors. */
  accentVariant?: string;
}

export interface Theme {
  key: string;
  /** Human label shown in the hero eyebrow, e.g. "Barbershop". */
  industryLabel: (category: string) => string;
  /** CSS palette. */
  ink: string;
  bg: string;
  accent: string;
  accent2: string;
  /** Section headings. */
  sections: { about: string; services: string; gallery: string; reviews: string; visit: string };
  /** One-line blurb under each service card. */
  serviceBlurb: (svc: string) => string;
  /** Industry defaults when the LLM has nothing better. */
  defaultServices: string[];
  /** Review-mining guidance passed to the LLM copywriter. */
  reviewMiningHint: string;
  /** Does a Places category string belong to this industry? */
  matches: (category: string) => boolean;
}

const has = (cat: string, ...keys: string[]) => keys.some((k) => cat.includes(k));

export const THEMES: Record<string, Theme> = {
  'salon-barber': {
    key: 'salon-barber',
    industryLabel: (c) => (c.includes('barber') ? 'Barbershop' : 'Hair Salon'),
    ink: '#15151b',
    bg: '#faf7f2',
    accent: '#0f766e',
    accent2: '#b45309',
    sections: { about: 'About us', services: 'What we do', gallery: 'The shop', reviews: 'What guests say', visit: 'Visit us' },
    serviceBlurb: (s) => `Ask about our ${s.toLowerCase()} when you book.`,
    defaultServices: ['Cuts & Styling', 'Color & Balayage', 'Treatments', 'Special Occasion'],
    reviewMiningHint:
      'Mine reviews for stylist/barber names, signature services, and the vibe guests mention (unhurried, family-friendly, old-school).',
    matches: (c) => has(c, 'salon', 'barber', 'hair'),
  },
  restaurant: {
    key: 'restaurant',
    industryLabel: (c) => (has(c, 'cafe', 'coffee') ? 'Café' : 'Restaurant'),
    ink: '#1c1410',
    bg: '#fdf8f0',
    accent: '#b91c1c',
    accent2: '#a16207',
    sections: { about: 'Our story', services: 'From the kitchen', gallery: 'The dining room', reviews: 'Table talk', visit: 'Come hungry' },
    serviceBlurb: (s) => `A house favorite — ask your server about ${s.toLowerCase()}.`,
    defaultServices: ['Signature Plates', 'Family Style', 'Takeout & Catering', 'Weekend Specials'],
    reviewMiningHint:
      'Mine reviews for standout dishes, atmosphere, and service moments; name specific menu items guests rave about.',
    matches: (c) => has(c, 'restaurant', 'taco', 'pizza', 'food', 'cafe', 'coffee', 'bakery', 'grill', 'bbq', 'diner'),
  },
  contractor: {
    key: 'contractor',
    industryLabel: (c) =>
      has(c, 'plumb') ? 'Plumbing' : has(c, 'roof') ? 'Roofing' : has(c, 'electric') ? 'Electrical' : has(c, 'hvac', 'air_condition') ? 'HVAC' : 'Home Services',
    ink: '#0f172a',
    bg: '#f6f8fa',
    accent: '#1d4ed8',
    accent2: '#b45309',
    sections: { about: 'Who we are', services: 'What we handle', gallery: 'Recent jobs', reviews: 'Homeowners say', visit: 'Get a quote' },
    serviceBlurb: (s) => `Licensed, insured, and upfront pricing on ${s.toLowerCase()}.`,
    defaultServices: ['Repairs & Emergencies', 'Installations', 'Inspections', 'Maintenance Plans'],
    reviewMiningHint:
      'Mine reviews for reliability signals: showed up on time, fair quote, cleaned up after, fixed it first visit. Lead with trust.',
    matches: (c) => has(c, 'plumb', 'roof', 'electric', 'hvac', 'contractor', 'handyman', 'remodel', 'landscap', 'air_condition'),
  },
  'auto-shop': {
    key: 'auto-shop',
    industryLabel: () => 'Auto Repair',
    ink: '#111318',
    bg: '#f4f5f7',
    accent: '#c2410c',
    accent2: '#334155',
    sections: { about: 'The shop', services: 'Services & repairs', gallery: 'In the bay', reviews: 'Drivers say', visit: 'Swing by' },
    serviceBlurb: (s) => `Straight answers and honest estimates on ${s.toLowerCase()}.`,
    defaultServices: ['Oil & Fluids', 'Brakes & Tires', 'Diagnostics', 'AC & Electrical'],
    reviewMiningHint:
      'Mine reviews for honesty signals: did not upsell, explained the fix, fair price, quick turnaround. Drivers buy trust, not torque specs.',
    matches: (c) => has(c, 'car_repair', 'auto', 'mechanic', 'tire', 'transmission', 'body_shop', 'oil_change'),
  },
  'dental-medspa': {
    key: 'dental-medspa',
    industryLabel: (c) => (has(c, 'dent') ? 'Dental Care' : 'Med Spa'),
    ink: '#132026',
    bg: '#f5fafb',
    accent: '#0e7490',
    accent2: '#7c3aed',
    sections: { about: 'Our practice', services: 'Treatments', gallery: 'The space', reviews: 'Patients say', visit: 'Book a visit' },
    serviceBlurb: (s) => `Gentle, modern ${s.toLowerCase()} — every visit explained.`,
    defaultServices: ['New Patient Exams', 'Cosmetic Treatments', 'Preventive Care', 'Financing Options'],
    reviewMiningHint:
      'Mine reviews for comfort and outcome: pain-free visits, staff who explain, results patients noticed. Calm and credible, never salesy.',
    matches: (c) => has(c, 'dent', 'med_spa', 'medspa', 'spa', 'dermatolog', 'aesthetic', 'wellness'),
  },
};

export const DEFAULT_TEMPLATE = 'salon-barber';

/** Choose a template key for a Places category. */
export function templateKeyFor(category: string | null): string {
  const cat = (category ?? '').toLowerCase();
  for (const theme of Object.values(THEMES)) {
    if (theme.matches(cat)) return theme.key;
  }
  return DEFAULT_TEMPLATE;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Render a one-page demo for the given template key. */
export function renderTemplate(key: string, d: TemplateData, opts: RenderOptions = {}): string {
  const base = THEMES[key] ?? THEMES[DEFAULT_TEMPLATE]!;
  // 'warm' accent variant: swap primary/secondary accents (A/B experiment).
  const t =
    opts.accentVariant === 'warm' ? { ...base, accent: base.accent2, accent2: base.accent } : base;
  const hero = d.photos[0] ?? '';
  const gallery = d.photos.slice(1, 4);
  const telHref = d.phone ? `tel:${d.phone.replace(/[^0-9+]/g, '')}` : '#book';
  const stars =
    d.rating != null
      ? '★'.repeat(Math.round(d.rating)) + '☆'.repeat(5 - Math.round(d.rating))
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${esc(d.tagline)} — ${esc(d.businessName)}, ${esc(d.city)}" />
<title>${esc(d.businessName)} — ${esc(d.city)}</title>
<style>
  :root { --ink:${t.ink}; --muted:#6b7280; --bg:${t.bg}; --accent:${t.accent}; --accent2:${t.accent2}; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Segoe UI',system-ui,-apple-system,sans-serif; color:var(--ink);
         background:var(--bg); line-height:1.55; }
  .wrap { max-width:1080px; margin:0 auto; padding:0 20px; }
  a { color:inherit; }
  .demo-banner { background:var(--ink); color:#fff; text-align:center; font-size:13px;
                 padding:7px 12px; letter-spacing:.02em; }
  header.hero { position:relative; min-height:460px; display:flex; align-items:flex-end;
    color:#fff; background:#222 center/cover no-repeat;
    background-image:linear-gradient(180deg,rgba(0,0,0,.15),rgba(0,0,0,.75)),url('${hero}'); }
  .hero-inner { padding:48px 0 40px; }
  .eyebrow { text-transform:uppercase; letter-spacing:.18em; font-size:12px; opacity:.85; }
  h1 { font-size:clamp(34px,6vw,60px); line-height:1.05; margin:6px 0 10px; font-weight:800; }
  .tagline { font-size:clamp(17px,2.4vw,22px); max-width:30ch; opacity:.95; }
  .cta-row { margin-top:22px; display:flex; gap:12px; flex-wrap:wrap; }
  .btn { display:inline-block; padding:13px 22px; border-radius:999px; font-weight:700;
         text-decoration:none; }
  .btn-primary { background:var(--accent); color:#fff; }
  .btn-ghost { background:rgba(255,255,255,.14); color:#fff; border:1px solid rgba(255,255,255,.5); }
  section { padding:56px 0; }
  .rating { color:var(--accent2); font-size:18px; }
  h2 { font-size:28px; margin-bottom:18px; }
  .about p { max-width:62ch; color:#333; font-size:18px; }
  .services { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:16px; }
  .svc { background:#fff; border:1px solid #e7e4de; border-radius:14px; padding:22px;
         box-shadow:0 1px 0 rgba(0,0,0,.03); }
  .svc h3 { font-size:18px; }
  .svc p { color:var(--muted); font-size:14px; margin-top:6px; }
  .gallery { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .gallery img { width:100%; height:200px; object-fit:cover; border-radius:12px; }
  .reviews { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
  .quote { background:#fff; border-radius:14px; padding:22px; border:1px solid #e7e4de; }
  .quote p { font-style:italic; color:#333; }
  .visit { display:grid; grid-template-columns:1fr 1fr; gap:28px; }
  .visit .card { background:#fff; border:1px solid #e7e4de; border-radius:14px; padding:24px; }
  .hours li { list-style:none; display:flex; justify-content:space-between; padding:5px 0;
              border-bottom:1px dashed #eee; }
  .mapish { background:linear-gradient(135deg,${t.accent}22,${t.accent2}22); border-radius:14px;
            min-height:180px; display:flex; align-items:center; justify-content:center;
            text-align:center; color:#444; padding:20px; border:1px solid #e7e4de; }
  footer { background:var(--ink); color:#cbd5e1; padding:34px 0; font-size:14px; }
  footer .demo-note { color:#9aa3b2; font-size:12px; margin-top:10px; }
  @media (max-width:640px){ .visit{grid-template-columns:1fr;} }
</style>
</head>
<body data-template="${esc(t.key)}">
  <div class="demo-banner">${esc(d.demoFooter)}</div>

  <header class="hero">
    <div class="wrap hero-inner">
      <div class="eyebrow">${esc(d.city)} · ${esc(t.industryLabel(d.category))}</div>
      <h1>${esc(d.businessName)}</h1>
      <p class="tagline">${esc(d.tagline)}</p>
      ${stars ? `<div class="rating" style="margin-top:14px;color:#ffd27a">${stars} <span style="color:#fff;opacity:.85;font-size:14px">${d.rating} · ${d.reviewCount ?? 0} reviews</span></div>` : ''}
      <div class="cta-row">
        <a class="btn btn-primary" href="${telHref}">${esc(d.cta)}</a>
        ${d.phone ? `<a class="btn btn-ghost" href="${telHref}">${esc(d.phone)}</a>` : ''}
      </div>
    </div>
  </header>

  <section class="about"><div class="wrap">
    <h2>${esc(t.sections.about)}</h2>
    <p>${esc(d.about)}</p>
  </div></section>

  <section style="background:#fff"><div class="wrap">
    <h2>${esc(t.sections.services)}</h2>
    <div class="services">
      ${d.services
        .map((s) => `<div class="svc"><h3>${esc(s)}</h3><p>${esc(t.serviceBlurb(s))}</p></div>`)
        .join('\n      ')}
    </div>
  </div></section>

  ${
    gallery.length
      ? `<section><div class="wrap"><h2>${esc(t.sections.gallery)}</h2><div class="gallery">
      ${gallery.map((p) => `<img src="${p}" alt="${esc(d.businessName)} photo" loading="lazy" />`).join('\n      ')}
    </div></div></section>`
      : ''
  }

  ${
    d.reviews.length
      ? `<section style="background:#fff"><div class="wrap"><h2>${esc(t.sections.reviews)}</h2><div class="reviews">
      ${d.reviews.map((r) => `<div class="quote"><p>&ldquo;${esc(r)}&rdquo;</p></div>`).join('\n      ')}
    </div></div></section>`
      : ''
  }

  <section id="book"><div class="wrap">
    <h2>${esc(t.sections.visit)}</h2>
    <div class="visit">
      <div class="card">
        <h3>Hours</h3>
        <ul class="hours">
          ${(d.hours.length ? d.hours : ['Call for hours']).map((h) => `<li><span>${esc(h)}</span></li>`).join('\n          ')}
        </ul>
        ${d.phone ? `<p style="margin-top:14px"><strong>Call:</strong> <a href="${telHref}">${esc(d.phone)}</a></p>` : ''}
      </div>
      <div class="card">
        <h3>Find us</h3>
        <div class="mapish">${esc(d.address ?? 'Address available on request')}</div>
      </div>
    </div>
  </div></section>

  <footer><div class="wrap">
    <strong>${esc(d.businessName)}</strong> · ${esc(d.address ?? d.city)}<br/>
    <div class="demo-note">${esc(d.demoFooter)}</div>
  </div></footer>
  ${d.beaconUrl ? `<img src="${esc(d.beaconUrl)}" alt="" width="1" height="1" style="position:absolute;opacity:0" />` : ''}
</body>
</html>`;
}

/** Back-compat wrapper (Phase 1 API). */
export function renderSalonTemplate(d: TemplateData): string {
  return renderTemplate('salon-barber', d);
}
