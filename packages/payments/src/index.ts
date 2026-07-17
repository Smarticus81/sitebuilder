// Payments adapter (Stripe live, mock default). ONLY creates payment links —
// URLs the customer can choose to open and pay. Nothing in this module can
// charge a card, and there is deliberately no charge/capture API surface.

import { fetchJson, type NetLogger } from '@storefront/net';

export interface PaymentLinkInput {
  /** Stable reference, e.g. "lead-42" — used for idempotency. */
  ref: string;
  description: string;
  amountCents: number;
  currency: string;
}

export interface PaymentLink {
  id: string;
  url: string;
}

export interface PaymentsProvider {
  readonly mode: 'live' | 'mock';
  readonly name: string;
  createPaymentLink(input: PaymentLinkInput): Promise<PaymentLink>;
}

export class MockPaymentsProvider implements PaymentsProvider {
  readonly mode = 'mock' as const;
  readonly name = 'mock';

  async createPaymentLink(input: PaymentLinkInput): Promise<PaymentLink> {
    const id = `plink_mock_${input.ref}`;
    return { id, url: `https://checkout.example.test/pay/${input.ref}` };
  }
}

interface StripePrice {
  id: string;
}
interface StripePaymentLink {
  id: string;
  url: string;
}

export class StripePaymentsProvider implements PaymentsProvider {
  readonly mode = 'live' as const;
  readonly name = 'stripe';
  constructor(
    private readonly apiKey: string,
    private readonly log?: NetLogger,
  ) {}

  private async post<T>(path: string, form: Record<string, string>, idem: string): Promise<T> {
    return fetchJson<T>(
      `https://api.stripe.com/v1/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': idem,
        },
        body: new URLSearchParams(form).toString(),
      },
      { service: 'payments', log: this.log },
    );
  }

  async createPaymentLink(input: PaymentLinkInput): Promise<PaymentLink> {
    const price = await this.post<StripePrice>(
      'prices',
      {
        'product_data[name]': input.description,
        unit_amount: String(input.amountCents),
        currency: input.currency,
      },
      `sf-price-${input.ref}`,
    );
    const link = await this.post<StripePaymentLink>(
      'payment_links',
      {
        'line_items[0][price]': price.id,
        'line_items[0][quantity]': '1',
      },
      `sf-plink-${input.ref}`,
    );
    return { id: link.id, url: link.url };
  }
}

export function createPaymentsProvider(
  env: NodeJS.ProcessEnv = process.env,
  log?: NetLogger,
): PaymentsProvider {
  const key = env.STRIPE_API_KEY?.trim();
  return key ? new StripePaymentsProvider(key, log) : new MockPaymentsProvider();
}
