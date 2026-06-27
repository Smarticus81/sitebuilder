// One polished, self-contained one-page template (salon / barber). All CSS is
// inlined and all images are passed as ready URLs (data URIs in mock mode) so
// the rendered demo is fully offline-renderable in the preview iframe.

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
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderSalonTemplate(d: TemplateData): string {
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
<title>${esc(d.businessName)} — ${esc(d.city)}</title>
<style>
  :root { --ink:#15151b; --muted:#6b7280; --bg:#faf7f2; --accent:#0f766e; --accent2:#b45309; }
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
  .svc { background:#fff; border:1px solid #ece7df; border-radius:14px; padding:22px;
         box-shadow:0 1px 0 rgba(0,0,0,.03); }
  .svc h3 { font-size:18px; }
  .svc p { color:var(--muted); font-size:14px; margin-top:6px; }
  .gallery { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .gallery img { width:100%; height:200px; object-fit:cover; border-radius:12px; }
  .reviews { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
  .quote { background:#fff; border-radius:14px; padding:22px; border:1px solid #ece7df; }
  .quote p { font-style:italic; color:#333; }
  .visit { display:grid; grid-template-columns:1fr 1fr; gap:28px; }
  .visit .card { background:#fff; border:1px solid #ece7df; border-radius:14px; padding:24px; }
  .hours li { list-style:none; display:flex; justify-content:space-between; padding:5px 0;
              border-bottom:1px dashed #eee; }
  .mapish { background:linear-gradient(135deg,#0f766e22,#b4530922); border-radius:14px;
            min-height:180px; display:flex; align-items:center; justify-content:center;
            text-align:center; color:#444; padding:20px; border:1px solid #ece7df; }
  footer { background:var(--ink); color:#cbd5e1; padding:34px 0; font-size:14px; }
  footer .demo-note { color:#9aa3b2; font-size:12px; margin-top:10px; }
  @media (max-width:640px){ .visit{grid-template-columns:1fr;} }
</style>
</head>
<body>
  <div class="demo-banner">${esc(d.demoFooter)}</div>

  <header class="hero">
    <div class="wrap hero-inner">
      <div class="eyebrow">${esc(d.city)} · ${d.category.includes('barber') ? 'Barbershop' : 'Hair Salon'}</div>
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
    <h2>About us</h2>
    <p>${esc(d.about)}</p>
  </div></section>

  <section style="background:#fff"><div class="wrap">
    <h2>What we do</h2>
    <div class="services">
      ${d.services
        .map(
          (s) => `<div class="svc"><h3>${esc(s)}</h3><p>Ask about our ${esc(s.toLowerCase())} when you book.</p></div>`,
        )
        .join('\n      ')}
    </div>
  </div></section>

  ${
    gallery.length
      ? `<section><div class="wrap"><h2>The shop</h2><div class="gallery">
      ${gallery.map((p) => `<img src="${p}" alt="${esc(d.businessName)} photo" loading="lazy" />`).join('\n      ')}
    </div></div></section>`
      : ''
  }

  ${
    d.reviews.length
      ? `<section style="background:#fff"><div class="wrap"><h2>What guests say</h2><div class="reviews">
      ${d.reviews.map((r) => `<div class="quote"><p>&ldquo;${esc(r)}&rdquo;</p></div>`).join('\n      ')}
    </div></div></section>`
      : ''
  }

  <section id="book"><div class="wrap">
    <h2>Visit us</h2>
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
</body>
</html>`;
}
