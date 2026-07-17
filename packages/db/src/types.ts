// Row types mirror schema.sql. SQLite stores booleans as 0/1 and JSON as TEXT.

export type LeadStatus =
  | 'discovered'
  | 'qualified'
  | 'demo_built'
  | 'ready'
  | 'contacted'
  | 'replied'
  | 'won'
  | 'lost';

export type Segment = 'none' | 'bad';
export type MessageChannel = 'email' | 'call_script';
export type MessageStatus = 'draft' | 'approved' | 'sent' | 'bounced' | 'canceled';
export type SequenceStatus = 'draft' | 'approved' | 'completed' | 'canceled';

export interface Lead {
  id: number;
  place_id: string;
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  website_url: string | null;
  segment: Segment | null;
  audit_json: string | null;
  score: number;
  contact_email: string | null;
  places_json: string | null;
  status: LeadStatus;
  demo_url: string | null;
  rating: number | null;
  review_count: number | null;
  created_at: string;
  updated_at: string;
}

export interface Demo {
  id: number;
  lead_id: number;
  template: string;
  copy_json: string | null;
  assets_json: string | null;
  subdomain: string | null;
  demo_url: string | null;
  published: number;
  unpublish_at: string | null;
  created_at: string;
}

export interface Message {
  id: number;
  lead_id: number;
  channel: MessageChannel;
  subject: string | null;
  body: string | null;
  status: MessageStatus;
  sent_at: string | null;
  approved_by: string | null;
  sequence_id: number | null;
  followup_step: number | null;
  created_at: string;
}

export interface Sequence {
  id: number;
  lead_id: number;
  status: SequenceStatus;
  approved_by: string | null;
  cancel_reason: string | null;
  max_followups: number;
  spacing_days: number;
  created_at: string;
  updated_at: string;
}

export interface Suppression {
  email: string;
  reason: string | null;
  created_at: string;
}

export interface ConfigRow {
  id: number;
  sender_name: string | null;
  sender_business: string | null;
  mailing_address: string | null;
  reply_to: string | null;
  from_domain: string | null;
  daily_send_cap: number;
  followup_days: number;
  demo_ttl_days: number;
  updated_at: string;
}

export interface EventRow {
  id: number;
  lead_id: number | null;
  type: string;
  payload_json: string | null;
  created_at: string;
}

// Full Lighthouse category scores, 0–100 each (null = not measured).
export interface LighthouseScores {
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
}

// Audit result persisted on leads.audit_json
export interface WebsiteAudit {
  reachable: boolean;
  https: boolean;
  mobileViewport: boolean;
  performanceScore: number | null; // 0–100, mirrors lighthouse.performance
  lighthouse: LighthouseScores | null;
  copyrightYear: number | null;
  stale: boolean;
  verdict: 'poor' | 'ok' | 'good';
  notes: string[];
}
