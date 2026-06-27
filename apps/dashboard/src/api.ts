export type LeadStatus =
  | 'discovered' | 'qualified' | 'demo_built' | 'ready'
  | 'contacted' | 'replied' | 'won' | 'lost';

export interface Audit {
  verdict: 'poor' | 'ok' | 'good';
  https: boolean;
  mobileViewport: boolean;
  performanceScore: number | null;
  copyrightYear: number | null;
  stale: boolean;
  notes: string[];
}

export interface Demo {
  id: number;
  demo_url: string | null;
  subdomain: string | null;
  published: number;
  unpublish_at: string | null;
}

export interface Message {
  id: number;
  subject: string | null;
  body: string | null;
  status: 'draft' | 'approved' | 'sent' | 'bounced';
  approved_by: string | null;
  sent_at: string | null;
}

export interface Lead {
  id: number;
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  website_url: string | null;
  segment: 'none' | 'bad' | null;
  score: number;
  contact_email: string | null;
  status: LeadStatus;
  demo_url: string | null;
  rating: number | null;
  review_count: number | null;
  audit: Audit | null;
  demo: Demo | null;
  message: Message | null;
}

export interface Health {
  ok: boolean;
  adapters: Record<string, 'live' | 'mock'>;
  config: {
    senderBusiness: string;
    dailySendCap: number;
    demoTtlDays: number;
    mailingAddressSet: boolean;
  };
}

async function http<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  health: () => http<Health>('/api/health'),
  leads: () => http<Lead[]>('/api/leads'),
  lead: (id: number) => http<Lead & { events: unknown[] }>(`/api/leads/${id}`),
  prospect: (category: string, location: string) =>
    http('/api/prospect', { method: 'POST', body: JSON.stringify({ category, location }) }),
  build: (id: number) => http(`/api/leads/${id}/build`, { method: 'POST' }),
  draft: (id: number) => http(`/api/leads/${id}/draft`, { method: 'POST' }),
  approve: (id: number) =>
    http(`/api/leads/${id}/approve`, { method: 'POST', body: JSON.stringify({ approvedBy: 'dashboard-user' }) }),
  send: (id: number, dryRun: boolean) =>
    http<{ sent: boolean; dryRun: boolean; gate: { ok: boolean; reasons: string[]; sentToday: number; cap: number } }>(
      `/api/leads/${id}/send`,
      { method: 'POST', body: JSON.stringify({ dryRun }) },
    ),
  setStatus: (id: number, status: LeadStatus) =>
    http(`/api/leads/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
};
