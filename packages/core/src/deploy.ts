import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchJson, fetchWithRetry, type NetLogger } from '@storefront/net';

export interface DeployInput {
  slug: string; // bare slug, e.g. "the-clip-joint"
  subdomain: string; // full demo host
  html: string;
}

export interface DeployResult {
  url: string;
  provider: 'local' | 'vercel';
}

export interface DeployProvider {
  readonly mode: 'live' | 'mock';
  deploy(input: DeployInput): Promise<DeployResult>;
  unpublish(slug: string): Promise<void>;
}

/**
 * Local deploy: writes the demo to ./demos-out/<slug>/index.html. The worker's
 * HTTP server serves ./demos-out at /demos, so the live URL actually resolves
 * in the dashboard preview iframe — fully offline.
 */
export class LocalDeployProvider implements DeployProvider {
  readonly mode = 'mock' as const;
  constructor(private readonly previewBase: string) {}

  async deploy(input: DeployInput): Promise<DeployResult> {
    const dir = resolve(process.cwd(), 'demos-out', input.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'index.html'), input.html);
    return { url: `${this.previewBase}/demos/${input.slug}/`, provider: 'local' };
  }

  async unpublish(slug: string): Promise<void> {
    const dir = resolve(process.cwd(), 'demos-out', slug);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Vercel deploy. Activates when VERCEL_TOKEN is set. Creates a deployment with
 * a single inline index.html, then aliases it to the demo subdomain (the base
 * domain must be added to the Vercel account for the alias to stick — if it
 * isn't, we log the failure and fall back to the *.vercel.app preview URL).
 * unpublish() removes the aliases and deletes every deployment for the slug.
 */
export class VercelDeployProvider implements DeployProvider {
  readonly mode = 'live' as const;
  constructor(
    private readonly token: string,
    private readonly teamId?: string,
    private readonly log?: NetLogger,
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(`https://api.vercel.com${path}`);
    if (this.teamId) u.searchParams.set('teamId', this.teamId);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  private appName(slug: string): string {
    return `storefront-${slug}`;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const data = await fetchJson<{ id: string; url?: string }>(
      this.url('/v13/deployments'),
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          name: this.appName(input.slug),
          target: 'production',
          files: [{ file: 'index.html', data: input.html }],
          projectSettings: { framework: null },
        }),
      },
      { service: 'deploy', timeoutMs: 60_000, log: this.log },
    );

    const previewUrl = data.url ? `https://${data.url}` : '';

    // Alias the deployment to the demo subdomain. Best-effort: a missing base
    // domain must not fail the build, but it IS logged for the operator.
    try {
      await fetchJson(
        this.url(`/v2/deployments/${data.id}/aliases`),
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ alias: input.subdomain }),
        },
        { service: 'deploy', log: this.log },
      );
      return { url: `https://${input.subdomain}`, provider: 'vercel' };
    } catch {
      this.log?.('deploy.alias_failed', {
        subdomain: input.subdomain,
        fallback: previewUrl,
        hint: 'Add the demo base domain to your Vercel account to enable custom subdomains',
      });
      return { url: previewUrl, provider: 'vercel' };
    }
  }

  async unpublish(slug: string): Promise<void> {
    // Every deployment created for this slug (there may be several rebuilds).
    const list = await fetchJson<{ deployments?: { uid: string }[] }>(
      this.url('/v6/deployments', { app: this.appName(slug), limit: '100' }),
      { method: 'GET', headers: this.headers },
      { service: 'deploy', log: this.log },
    );
    for (const d of list.deployments ?? []) {
      const res = await fetchWithRetry(
        this.url(`/v13/deployments/${d.uid}`),
        { method: 'DELETE', headers: this.headers },
        { service: 'deploy', log: this.log },
      );
      // 404 means already gone — fine. Anything else non-2xx is a real failure.
      if (!res.ok && res.status !== 404) {
        throw new Error(`Vercel delete failed for ${d.uid}: ${res.status}`);
      }
    }
    this.log?.('deploy.unpublished', { slug, deployments: (list.deployments ?? []).length });
  }
}

export function createDeployProvider(
  env: NodeJS.ProcessEnv = process.env,
  log?: NetLogger,
): DeployProvider {
  const token = env.VERCEL_TOKEN?.trim();
  if (token) return new VercelDeployProvider(token, env.VERCEL_TEAM_ID?.trim() || undefined, log);
  const port = env.WORKER_PORT ?? '8787';
  const previewBase = env.DEMO_PREVIEW_BASE ?? `http://localhost:${port}`;
  return new LocalDeployProvider(previewBase);
}
