// SMS adapter (Twilio live, mock default). Mirrors the email adapter contract:
// the mock writes to data/sms-outbox so a human can inspect exactly what would
// have gone out; nothing touches the network without TWILIO_* keys.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchWithRetry, type NetLogger } from '@storefront/net';

export interface SmsSend {
  to: string;
  from: string;
  body: string;
}

export interface SmsSendResult {
  ok: boolean;
  id: string;
  provider: string;
  error?: string;
}

export interface SmsProvider {
  readonly mode: 'live' | 'mock';
  readonly name: string;
  send(msg: SmsSend): Promise<SmsSendResult>;
}

export class MockSmsProvider implements SmsProvider {
  readonly mode = 'mock' as const;
  readonly name = 'mock';
  private seq = 0;

  async send(msg: SmsSend): Promise<SmsSendResult> {
    const dir = resolve(process.cwd(), 'data', 'sms-outbox');
    mkdirSync(dir, { recursive: true });
    const id = `mock_sms_${Date.now()}_${++this.seq}`;
    writeFileSync(resolve(dir, `${id}.json`), JSON.stringify(msg, null, 2));
    return { ok: true, id, provider: 'mock' };
  }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly mode = 'live' as const;
  readonly name = 'twilio';
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly log?: NetLogger,
  ) {}

  async send(msg: SmsSend): Promise<SmsSendResult> {
    try {
      const res = await fetchWithRetry(
        `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization:
              'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64'),
          },
          body: new URLSearchParams({
            To: msg.to,
            From: msg.from || this.fromNumber,
            Body: msg.body,
          }).toString(),
        },
        // Twilio's create-message API has no idempotency key — a retry could
        // double-text a human. Never retry; surface the failure instead.
        { service: 'sms', log: this.log, retryable: false },
      );
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        this.log?.('adapter.error', { service: 'sms', status: res.status, body });
        return { ok: false, id: '', provider: 'twilio', error: `${res.status} ${body}` };
      }
      const data = (await res.json()) as { sid: string };
      return { ok: true, id: data.sid, provider: 'twilio' };
    } catch (err) {
      return { ok: false, id: '', provider: 'twilio', error: String(err) };
    }
  }
}

export function createSmsProvider(
  env: NodeJS.ProcessEnv = process.env,
  log?: NetLogger,
): SmsProvider {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const token = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_FROM_NUMBER?.trim();
  if (sid && token && from) return new TwilioSmsProvider(sid, token, from, log);
  return new MockSmsProvider();
}
