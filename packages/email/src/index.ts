import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EmailMessage {
  to: string;
  from: string; // "Name <addr@from_domain>"
  replyTo: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>; // e.g. List-Unsubscribe
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
  constructor(private readonly apiKey: string) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
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
      });
      if (!res.ok) {
        return {
          ok: false,
          id: '',
          provider: 'resend',
          error: `${res.status} ${await res.text()}`,
        };
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
): EmailProvider {
  const provider = (env.EMAIL_PROVIDER ?? 'mock').toLowerCase();
  const key = env.EMAIL_PROVIDER_API_KEY?.trim();
  if (provider === 'resend' && key) return new ResendEmailProvider(key);
  // postmark / ses can be added here following the same interface.
  return new MockEmailProvider();
}
