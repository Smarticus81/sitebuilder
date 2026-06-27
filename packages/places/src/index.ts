import { FORT_WORTH_SALONS } from './fixtures.js';
import type { PlaceResult, PlacesProvider, SearchParams } from './types.js';

export * from './types.js';

// ── Mock provider ────────────────────────────────────────────────────────────
// Deterministic, offline. Filters the fixture set by a loose category/location
// match so `prospect --category "hair salon" --location "Fort Worth"` returns
// the salon set.
export class MockPlacesProvider implements PlacesProvider {
  readonly mode = 'mock' as const;

  async textSearch(params: SearchParams): Promise<PlaceResult[]> {
    const cat = params.category.toLowerCase();
    const matchesCat =
      cat.includes('salon') ||
      cat.includes('barber') ||
      cat.includes('hair') ||
      cat === '';
    const results = matchesCat ? FORT_WORTH_SALONS : [];
    return results.slice(0, params.limit ?? results.length);
  }

  photoUrl(ref: string): string {
    // Offline placeholder: a labeled SVG as a data URI so demos render with no
    // network. Real provider returns a hosted Google photo URL.
    const palette = ['#1f2937', '#0f766e', '#7c3aed', '#b45309', '#be123c'];
    let hash = 0;
    for (const ch of ref) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const color = palette[hash % palette.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'>
      <rect width='100%' height='100%' fill='${color}'/>
      <text x='50%' y='50%' fill='white' font-family='sans-serif' font-size='28'
        text-anchor='middle' dominant-baseline='middle' opacity='0.85'>Salon photo</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
}

// ── Live provider (Google Places API, New) ───────────────────────────────────
// Implemented against the Places API "searchText" endpoint. Wire format is
// normalized to PlaceResult. Activates only when GOOGLE_PLACES_API_KEY is set.
export class GooglePlacesProvider implements PlacesProvider {
  readonly mode = 'live' as const;
  constructor(private readonly apiKey: string) {}

  async textSearch(params: SearchParams): Promise<PlaceResult[]> {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.primaryType',
          'places.formattedAddress',
          'places.nationalPhoneNumber',
          'places.location',
          'places.websiteUri',
          'places.rating',
          'places.userRatingCount',
          'places.businessStatus',
          'places.photos',
          'places.reviews',
          'places.regularOpeningHours',
        ].join(','),
      },
      body: JSON.stringify({
        textQuery: `${params.category} in ${params.location}`,
        maxResultCount: Math.min(params.limit ?? 20, 20),
      }),
    });
    if (!res.ok) {
      throw new Error(`Places searchText failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { places?: GooglePlace[] };
    return (data.places ?? []).map(normalize);
  }

  photoUrl(ref: string): string {
    // `ref` is a Google photo resource name: places/X/photos/Y
    return `https://places.googleapis.com/v1/${ref}/media?maxWidthPx=1200&key=${this.apiKey}`;
  }
}

interface GooglePlace {
  id: string;
  displayName?: { text: string };
  primaryType?: string;
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  location?: { latitude: number; longitude: number };
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  photos?: { name: string }[];
  reviews?: { text?: { text: string } }[];
  regularOpeningHours?: { weekdayDescriptions?: string[] };
}

function normalize(p: GooglePlace): PlaceResult {
  return {
    placeId: p.id,
    name: p.displayName?.text ?? 'Unknown',
    category: p.primaryType ?? 'establishment',
    address: p.formattedAddress ?? '',
    phone: p.nationalPhoneNumber ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    website: p.websiteUri ?? null,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? 'OPERATIONAL',
    photoRefs: (p.photos ?? []).map((ph) => ph.name).slice(0, 4),
    topReviews: (p.reviews ?? [])
      .map((r) => r.text?.text ?? '')
      .filter(Boolean)
      .slice(0, 3),
    hours: p.regularOpeningHours?.weekdayDescriptions ?? [],
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────
export function createPlacesProvider(
  env: NodeJS.ProcessEnv = process.env,
): PlacesProvider {
  const key = env.GOOGLE_PLACES_API_KEY?.trim();
  return key ? new GooglePlacesProvider(key) : new MockPlacesProvider();
}
