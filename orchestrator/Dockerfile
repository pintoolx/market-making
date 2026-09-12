FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV MANDATE_STATE_DIR=/data/mandates
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY orchestrator/package.json orchestrator/package.json
RUN pnpm install --frozen-lockfile --prod --filter @pintool/mandate-service...

COPY orchestrator orchestrator
RUN mkdir -p /data/mandates && chown -R node:node /data
WORKDIR /workspace/orchestrator
USER node
CMD ["node", "src/server.mjs"]
