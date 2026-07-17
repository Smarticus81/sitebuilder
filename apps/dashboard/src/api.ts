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

// Deployed dashboards point at the worker with VITE_API_URL; locally the Vite
// proxy keeps everything same-origin.
const API_BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '';

export function getSessionToken(): string | null {
  return localStorage.getItem('storefront.token');
}
export function setSessionToken(token: string | null): void {
  if (token) localStorage.setItem('storefront.token', token);
  else localStorage.removeItem('storefront.token');
}

export class AuthRequiredError extends Error {
  constructor() {
    super('authentication required');
    this.name = 'AuthRequiredError';
  }
}

async function http<T>(url: string, opts?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const res = await fetch(`${API_BASE}${url}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new AuthRequiredError();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export interface AnalyticsTotals {
  leads: number;
  emailsSent: number;
  smsSent: number;
  opens: number;
  replies: number;
  demoViews: number;
  won: number;
  lost: number;
  closeRate: number | null;
  mrrCents: number;
  oneTimeRevenueCents: number;
}

export interface BreakdownRow {
  key: string;
  leads: number;
  demosBuilt: number;
  emailsSent: number;
  replies: number;
  won: number;
}

export interface VariantReport {
  variant: string;
  leads: number;
  sent: number;
  replies: number;
  won: number;
  replyRate: number | null;
}

export interface ExperimentReport {
  name: string;
  kind: string;
  winner: string | null;
  concludedBy: string | null;
  leader: string | null;
  variants: VariantReport[];
}

export interface Analytics {
  totals: AnalyticsTotals;
  byTemplate: BreakdownRow[];
  bySegment: BreakdownRow[];
  experiments: ExperimentReport[];
}

export const api = {
  login: async (password: string) => {
    const r = await http<{ ok: boolean; token: string | null }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (r.token) setSessionToken(r.token);
    return r;
  },
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
  analytics: () => http<Analytics>('/api/analytics'),
  concludeExperiment: (name: string, winner: string) =>
    http(`/api/experiments/${name}/conclude`, {
      method: 'POST',
      body: JSON.stringify({ winner, concludedBy: 'dashboard-user' }),
    }),
};
