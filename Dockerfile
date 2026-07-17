# Storefront worker API (Railway / Fly / Render). The dashboard deploys
# separately (Vercel — see apps/dashboard/vercel.json).
FROM node:22-slim

WORKDIR /app
RUN corepack enable

# Install with the full workspace context (better-sqlite3 needs build tools).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --prod=false

ENV NODE_ENV=production
EXPOSE 8787

# Health check hits the public health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "server"]
