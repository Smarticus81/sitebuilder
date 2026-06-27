// Reading a prospect's OWN public website to find their contact email is
// permitted by the spec. Mock-first: fixture hosts return a canned address.

const MOCK_EMAILS: Record<string, string | null> = {
  'clipjointfw.com': 'hello@clipjointfw.com',
  'shearelegancefw.weebly.com': 'shearelegancefw@gmail.com',
  'maneattractionfortworth.com': 'book@maneattractionfortworth.com',
  'latherandfadefw.com': 'shop@latherandfadefw.com',
  'bombshellbeautyfw.com': 'hello@bombshellbeautyfw.com',
  'polishedmodern.com': 'hi@polishedmodern.com',
};

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Returns the best-guess contact email found on the site, or null. */
export async function scrapeContactEmail(
  websiteUrl: string | null,
): Promise<string | null> {
  if (!websiteUrl) return null;
  const h = host(websiteUrl);
  if (h in MOCK_EMAILS) return MOCK_EMAILS[h] ?? null;

  // Live path: fetch homepage + a likely contact page, regex out an address.
  for (const path of ['', '/contact', '/contact-us', '/about']) {
    try {
      const res = await fetch(new URL(path, websiteUrl).toString());
      if (!res.ok) continue;
      const html = await res.text();
      const matches = html.match(EMAIL_RE) ?? [];
      const cleaned = matches
        .map((m) => m.toLowerCase())
        .filter((m) => !/\.(png|jpg|jpeg|gif|webp|svg)$/.test(m))
        .filter((m) => !m.includes('example.com') && !m.includes('sentry'));
      // Prefer an address on the business's own domain.
      const onDomain = cleaned.find((m) => m.endsWith(`@${h}`));
      if (onDomain) return onDomain;
      if (cleaned[0]) return cleaned[0];
    } catch {
      // try next path
    }
  }
  return null;
}
