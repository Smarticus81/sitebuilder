// Boot-time / doctor-time environment validation. Errors block live sending;
// warnings are operator hygiene. Never echoes secret VALUES — only key names.

export interface EnvReport {
  errors: string[];
  warnings: string[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Sender identity — CAN-SPAM requires all of these to be real.
  if (!env.SENDER_NAME?.trim() || env.SENDER_NAME === 'Unknown Sender')
    errors.push('SENDER_NAME is unset');
  if (!env.SENDER_BUSINESS?.trim()) errors.push('SENDER_BUSINESS is unset');
  if (!env.MAILING_ADDRESS?.trim())
    errors.push('MAILING_ADDRESS is unset — CAN-SPAM requires a physical mailing address');
  if (!env.REPLY_TO?.trim() || !EMAIL_RE.test(env.REPLY_TO))
    errors.push('REPLY_TO is missing or not a valid email address');

  const fromDomain = env.FROM_DOMAIN?.trim() ?? '';
  if (!fromDomain || fromDomain.includes('example.com'))
    errors.push('FROM_DOMAIN is unset or still the example value');
  else if (fromDomain.split('.').length < 3)
    warnings.push(
      `FROM_DOMAIN "${fromDomain}" looks like an apex domain — use a dedicated ` +
        `sending subdomain (e.g. outreach.yourdomain.com) to protect root-domain reputation`,
    );

  // Pipeline policy sanity.
  const cap = Number(env.DAILY_SEND_CAP ?? '15');
  if (!Number.isFinite(cap) || cap < 1) errors.push('DAILY_SEND_CAP must be a positive number');
  else if (cap > 100)
    warnings.push(`DAILY_SEND_CAP=${cap} is aggressive for a cold domain — consider a warm-up ramp`);

  // Secrets hygiene.
  if (!env.UNSUBSCRIBE_SECRET?.trim())
    warnings.push('UNSUBSCRIBE_SECRET is unset — unsubscribe tokens use the built-in dev secret');
  if (!env.DASHBOARD_PASSWORD?.trim())
    warnings.push('DASHBOARD_PASSWORD is unset — dashboard/API auth is disabled (required in production)');

  if ((env.EMAIL_PROVIDER ?? 'mock') !== 'mock' && !env.EMAIL_PROVIDER_API_KEY?.trim())
    errors.push(`EMAIL_PROVIDER=${env.EMAIL_PROVIDER} but EMAIL_PROVIDER_API_KEY is unset`);

  if (env.DEMO_BASE_DOMAIN?.includes('example.com'))
    warnings.push('DEMO_BASE_DOMAIN is still the example value — demo subdomains will not resolve');

  return { errors, warnings };
}
