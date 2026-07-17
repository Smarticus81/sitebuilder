import {
  insertDemo,
  setLeadStatus,
  updateLead,
  logEvent,
  type DB,
  type Demo,
  type Lead,
} from '@storefront/db';
import type { LlmProvider } from '@storefront/llm';
import type { PlacesProvider, PlaceResult } from '@storefront/places';
import type { StorefrontConfig } from './config.js';
import type { DeployProvider } from './deploy.js';
import { renderTemplate, templateKeyFor, THEMES, type TemplateData } from './template.js';
import { slugify, subdomainFor } from './slug.js';
import { assignVariant } from './ab.js';
import { publicBaseUrl } from './compliance.js';

export interface BuildDeps {
  db: DB;
  llm: LlmProvider;
  places: PlacesProvider;
  deploy: DeployProvider;
  config: StorefrontConfig;
}

/** Best-effort city extraction from a US street address. */
export function cityFrom(address: string | null): string {
  if (!address) return 'your town';
  const parts = address.split(',').map((p) => p.trim());
  return parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
}

/** Choose a template by category (Phase 2: five industry templates). */
export function templateFor(category: string | null): string {
  return templateKeyFor(category);
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/**
 * Build a one-page demo for a qualified lead: LLM copy + Places assets →
 * rendered HTML → deployed to a temp subdomain. Persists the demo, stamps the
 * live URL on the lead, and advances status to `demo_built`.
 */
export async function buildDemo(deps: BuildDeps, lead: Lead): Promise<Demo> {
  const { db, llm, places, deploy, config } = deps;
  const place: PlaceResult | null = lead.places_json
    ? (JSON.parse(lead.places_json) as PlaceResult)
    : null;

  const city = cityFrom(lead.address);
  const reviews = place?.topReviews ?? [];
  const photos = (place?.photoRefs ?? []).map((ref) => places.photoUrl(ref));
  const hours = place?.hours ?? [];

  const templateKey = templateFor(lead.category);
  const theme = THEMES[templateKey]!;
  const copy = await llm.demoCopy({
    name: lead.name,
    category: lead.category ?? 'hair_salon',
    city,
    reviews,
    services: theme.defaultServices,
    industryHint: theme.reviewMiningHint,
  });

  const slug = slugify(lead.name);
  const subdomain = subdomainFor(lead.name, config.demoBaseDomain);

  const data: TemplateData = {
    businessName: lead.name,
    city,
    category: lead.category ?? 'hair_salon',
    tagline: copy.tagline,
    about: copy.about,
    services: copy.services,
    cta: copy.cta,
    phone: lead.phone,
    address: lead.address,
    hours,
    photos,
    rating: lead.rating,
    reviewCount: lead.review_count,
    reviews,
    demoFooter: `Demo preview prepared by ${config.senderBusiness} · not affiliated with ${lead.name} · this is a temporary preview`,
    beaconUrl: `${publicBaseUrl()}/beacon/demo/${slug}`,
  };

  // A/B: template accent variant — assignment stable per lead, audit-logged.
  const accentVariant = await assignVariant(db, 'template-accent', lead.id);
  const html = renderTemplate(templateKey, data, { accentVariant });
  const { url, provider } = await deploy.deploy({ slug, subdomain, html });

  const demo = await insertDemo(db, {
    lead_id: lead.id,
    template: templateKey,
    copy_json: JSON.stringify(copy),
    assets_json: JSON.stringify({ photos, hours, reviews, subdomain }),
    subdomain,
    demo_url: url,
    published: 1,
    unpublish_at: addDays(config.demoTtlDays),
  });

  await updateLead(db, lead.id, { demo_url: url });
  await logEvent(db, 'demo.built', lead.id, { demo_id: demo.id, url, provider });
  await setLeadStatus(db, lead.id, 'demo_built', { demo_url: url });
  return demo;
}
