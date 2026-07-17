// One module wraps ALL LLM calls. Mock provider is deterministic so the
// pipeline runs offline; AnthropicProvider activates when ANTHROPIC_API_KEY set.

import { fetchJson, type NetLogger } from '@storefront/net';

export interface DemoCopyInput {
  name: string;
  category: string;
  city: string;
  reviews: string[];
  /** Industry-default service names (from the template theme). */
  services?: string[];
  /** Per-template review-mining guidance for the copywriter. */
  industryHint?: string;
}

export interface DemoCopy {
  tagline: string;
  about: string;
  services: string[];
  cta: string;
}

export interface OutreachInput {
  businessName: string;
  city: string;
  observation: string; // one concrete thing about their current site
  demoUrl: string;
  senderName: string;
  senderBusiness: string;
}

export interface OutreachDraft {
  subject: string;
  body: string; // personalized body WITHOUT the compliance footer
}

export interface LlmProvider {
  readonly mode: 'live' | 'mock';
  demoCopy(input: DemoCopyInput): Promise<DemoCopy>;
  outreach(input: OutreachInput): Promise<OutreachDraft>;
}

const DEFAULT_SERVICES: Record<string, string[]> = {
  hair_salon: ['Cuts & Styling', 'Color & Balayage', 'Treatments', 'Special Occasion'],
  barber_shop: ['Classic Cuts', 'Skin Fades', 'Beard Trims', 'Hot Towel Shaves'],
};

function servicesFor(category: string, fallback?: string[]): string[] {
  return DEFAULT_SERVICES[category] ?? fallback ?? ['Our Services', 'Book a Visit'];
}

// Deterministic industry flavor for the mock copywriter.
const MOCK_FLAVOR: { match: (c: string) => boolean; noun: string; tagline: (city: string) => string; cta: string }[] = [
  {
    match: (c) => c.includes('barber'),
    noun: 'barbershop',
    tagline: (city) => `${city}'s sharpest cuts, every chair.`,
    cta: 'Call or book your chair today',
  },
  {
    match: (c) => /restaurant|taco|pizza|food|cafe|coffee|bakery|grill|bbq|diner/.test(c),
    noun: 'kitchen',
    tagline: (city) => `${city}'s table worth talking about.`,
    cta: 'Call ahead or walk right in',
  },
  {
    match: (c) => /plumb|roof|electric|hvac|contractor|handyman|remodel|landscap|air_condition/.test(c),
    noun: 'crew',
    tagline: () => `Done right, priced straight.`,
    cta: 'Call for a free quote',
  },
  {
    match: (c) => /car_repair|auto|mechanic|tire|transmission|body_shop|oil_change/.test(c),
    noun: 'garage',
    tagline: () => `Honest wrenching, no surprises.`,
    cta: 'Call the shop today',
  },
  {
    match: (c) => /dent|med_spa|medspa|spa|dermatolog|aesthetic|wellness/.test(c),
    noun: 'practice',
    tagline: () => `Feel looked after, not processed.`,
    cta: 'Book your visit today',
  },
];

// ── Mock ─────────────────────────────────────────────────────────────────────
export class MockLlmProvider implements LlmProvider {
  readonly mode = 'mock' as const;

  async demoCopy(input: DemoCopyInput): Promise<DemoCopy> {
    const cat = input.category.toLowerCase();
    const flavor = MOCK_FLAVOR.find((f) => f.match(cat)) ?? {
      noun: 'salon',
      tagline: () => `Look your best. Feel even better.`,
      cta: 'Call or book your chair today',
      match: () => true,
    };
    return {
      tagline: flavor.tagline(input.city),
      about:
        `${input.name} is a ${input.city} ${flavor.noun} our neighbors keep coming back to. ` +
        `Guests describe it as ${input.reviews[0] ? `"${trim(input.reviews[0])}"` : 'warm, skilled, and unhurried'}. ` +
        `Stop in for a quick visit or book ahead for the full experience — either way you leave glad you came.`,
      services: servicesFor(input.category, input.services),
      cta: flavor.cta,
    };
  }

  async outreach(input: OutreachInput): Promise<OutreachDraft> {
    return {
      subject: `A fresh website for ${input.businessName} (free preview inside)`,
      body:
        `Hi ${input.businessName} team,\n\n` +
        `I'm ${input.senderName} with ${input.senderBusiness}, a small studio here in ` +
        `${input.city}. I noticed ${input.observation}, so I went ahead and built you a ` +
        `free preview of what a modern site could look like:\n\n` +
        `${input.demoUrl}\n\n` +
        `It pulls in your real reviews, hours, and photos — no obligation, just take a ` +
        `look. If you like it, I can have it live on your own domain in a few days. If ` +
        `it's not for you, no worries at all.\n\n` +
        `Happy to tweak anything you'd want changed.\n\n` +
        `Best,\n${input.senderName}\n${input.senderBusiness}`,
    };
  }
}

// ── Anthropic (live) ─────────────────────────────────────────────────────────
export class AnthropicLlmProvider implements LlmProvider {
  readonly mode = 'live' as const;
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
    private readonly log?: NetLogger,
  ) {}

  private async complete(system: string, user: string): Promise<string> {
    const data = await fetchJson<{ content: { type: string; text?: string }[] }>(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      },
      { service: 'llm', timeoutMs: 60_000, log: this.log },
    );
    return data.content.map((c) => c.text ?? '').join('').trim();
  }

  private parseJson<T>(raw: string): T {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`LLM did not return JSON: ${raw.slice(0, 200)}`);
    return JSON.parse(match[0]) as T;
  }

  async demoCopy(input: DemoCopyInput): Promise<DemoCopy> {
    const raw = await this.complete(
      'You are a senior copywriter for small local businesses. Return ONLY JSON.',
      `Write website copy for a local business demo.\n` +
        `Business: ${input.name}\nCategory: ${input.category}\nCity: ${input.city}\n` +
        (input.industryHint ? `Industry guidance: ${input.industryHint}\n` : '') +
        (input.services?.length ? `Typical services for this industry: ${input.services.join(', ')}\n` : '') +
        `Top reviews:\n${input.reviews.map((r) => `- ${r}`).join('\n')}\n\n` +
        `Return JSON: { "tagline": string (<=8 words), "about": string (2-3 sentences), ` +
        `"services": string[] (4 items), "cta": string (<=6 words) }. ` +
        `Warm, specific, no hype, no emojis.`,
    );
    return this.parseJson<DemoCopy>(raw);
  }

  async outreach(input: OutreachInput): Promise<OutreachDraft> {
    const raw = await this.complete(
      'You write short, honest, non-spammy B2B outreach emails. Return ONLY JSON.',
      `Draft a cold outreach email.\n` +
        `Business: ${input.businessName} (${input.city})\n` +
        `Concrete observation about their current site: ${input.observation}\n` +
        `Free demo URL to link: ${input.demoUrl}\n` +
        `Sender: ${input.senderName}, ${input.senderBusiness}\n\n` +
        `Return JSON: { "subject": string (truthful, no clickbait), "body": string }. ` +
        `Body: 120-160 words, reference the specific business and observation, link the ` +
        `demo once, soft CTA, sign off as the sender. Do NOT include an address or ` +
        `unsubscribe line — those are appended later.`,
    );
    return this.parseJson<OutreachDraft>(raw);
  }
}

function trim(s: string, n = 90): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function createLlmProvider(
  env: NodeJS.ProcessEnv = process.env,
  log?: NetLogger,
): LlmProvider {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key
    ? new AnthropicLlmProvider(key, env.ANTHROPIC_MODEL ?? 'claude-opus-4-8', log)
    : new MockLlmProvider();
}
