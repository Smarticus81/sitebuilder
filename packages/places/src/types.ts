/** Normalized place record (independent of Google's wire format). */
export interface PlaceResult {
  placeId: string;
  name: string;
  category: string;
  address: string;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string; // OPERATIONAL | CLOSED_TEMPORARILY | ...
  photoRefs: string[];
  topReviews: string[]; // short snippets used for demo copy
  hours: string[]; // e.g. ["Mon 9–6", ...]
}

export interface SearchParams {
  category: string;
  location: string; // free-text city/area, e.g. "Fort Worth, TX"
  limit?: number;
}

export interface PlacesProvider {
  readonly mode: 'live' | 'mock';
  textSearch(params: SearchParams): Promise<PlaceResult[]>;
  /** Map an opaque photo ref to a usable image URL. */
  photoUrl(ref: string): string;
}
