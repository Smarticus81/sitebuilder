import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
 * Vercel preview deploy. Activates when VERCEL_TOKEN is set. Creates a
 * deployment with a single inline index.html file. (Custom-subdomain aliasing
 * is left as a follow-up; the generated *.vercel.app preview URL is returned.)
 */
export class VercelDeployProvider implements DeployProvider {
  readonly mode = 'live' as const;
  constructor(private readonly token: string) {}

  async deploy(input: DeployInput): Promise<DeployResult> {
    const res = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `storefront-${input.slug}`,
        target: 'preview',
        files: [{ file: 'index.html', data: input.html }],
        projectSettings: { framework: null },
      }),
    });
    if (!res.ok) {
      throw new Error(`Vercel deploy failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { url?: string };
    return { url: data.url ? `https://${data.url}` : '', provider: 'vercel' };
  }

  async unpublish(_slug: string): Promise<void> {
    // Real impl: look up deployment id by name and DELETE it. Left for Phase 2.
  }
}

export function createDeployProvider(
  env: NodeJS.ProcessEnv = process.env,
): DeployProvider {
  const token = env.VERCEL_TOKEN?.trim();
  if (token) return new VercelDeployProvider(token);
  const port = env.WORKER_PORT ?? '8787';
  const previewBase = env.DEMO_PREVIEW_BASE ?? `http://localhost:${port}`;
  return new LocalDeployProvider(previewBase);
}
