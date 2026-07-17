import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchWithRetry, type NetLogger } from '@storefront/net';

export interface EmailMessage {
  to: string;
  from: string; // "Name <addr@from_domain>"
  replyTo: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>; // e.g. List-Unsubscribe
  /**
   * Stable key per logical message (e.g. "msg-42"). Lets the provider retry a
   * send on transient failure WITHOUT risking a duplicate email. Sends with no
   * key are never retried.
   */
  idempotencyKey?: string;
}

export interface SendResult {
  ok: boolean;
  id: string;
  provider: string;
  error?: string;
}

export interface EmailProvider {
  readonly mode: 'live' | 'mock';
  readonly name: string;
  send(msg: EmailMessage): Promise<SendResult>;
}

// ── Mock ─────────────────────────────────────────────────────────────────────
// Writes each "sent" message to ./data/outbox as JSON so a human can inspect
// exactly what would have gone out. Never touches the network.
export class MockEmailProvider implements EmailProvider {
  readonly mode = 'mock' as const;
  readonly name = 'mock';
  private seq = 0;

  async send(msg: EmailMessage): Promise<SendResult> {
    const dir = resolve(process.cwd(), 'data', 'outbox');
    mkdirSync(dir, { recursive: true });
    const id = `mock_${Date.now()}_${++this.seq}`;
    writeFileSync(resolve(dir, `${id}.json`), JSON.stringify(msg, null, 2));
    return { ok: true, id, provider: 'mock' };
  }
}

// ── Resend (live) ────────────────────────────────────────────────────────────
export class ResendEmailProvider implements EmailProvider {
  readonly mode = 'live' as const;
  readonly name = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly log?: NetLogger,
  ) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    try {
      const res = await fetchWithRetry(
        'https://api.resend.com/emails',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from: msg.from,
            to: msg.to,
            reply_to: msg.replyTo,
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
            headers: msg.headers,
          }),
        },
        {
          service: 'email',
          log: this.log,
          // A duplicated send is worse than a failed one: only retry when the
          // Idempotency-Key makes the request safe to repeat.
          retryable: !!msg.idempotencyKey,
        },
      );
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        this.log?.('adapter.error', { service: 'email', status: res.status, body });
        return { ok: false, id: '', provider: 'resend', error: `${res.status} ${body}` };
      }
      const data = (await res.json()) as { id: string };
      return { ok: true, id: data.id, provider: 'resend' };
    } catch (err) {
      return { ok: false, id: '', provider: 'resend', error: String(err) };
    }
  }
}

export function createEmailProvider(
  env: NodeJS.ProcessEnv = process.env,
  log?: NetLogger,
): EmailProvider {
  const provider = (env.EMAIL_PROVIDER ?? 'mock').toLowerCase();
  const key = env.EMAIL_PROVIDER_API_KEY?.trim();
  if (provider === 'resend' && key) return new ResendEmailProvider(key, log);
  // postmark / ses can be added here following the same interface.
  return new MockEmailProvider();
}
