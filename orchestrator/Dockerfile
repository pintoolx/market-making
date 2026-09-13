FROM oven/bun:1.4.2 AS bun-runtime

FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV HOME=/home/node
ENV MANDATE_STATE_DIR=/data/mandates
ENV CRE_CLI=/usr/local/bin/cre
ENV CRE_TOOL_PATH=/usr/local/bin
ENV CRE_PROJECT_DIR=/workspace/workflow
ENV CRE_WORKFLOW_DIR=market-maker-auth
ENV CRE_TARGET=staging-settings
ENV MANDATE_RUNNER=/workspace/orchestrator/bin/cre-local-simulation-runner
WORKDIR /workspace

ADD --checksum=sha256:af8dd82dcaca1497fa1e74356abc4a23704915341350834a503860cd1b280739 \
    https://github.com/smartcontractkit/cre-cli/releases/download/v1.33.0/cre_linux_amd64_ldd2-35.tar.gz \
    /tmp/cre.tar.gz
RUN tar -xzf /tmp/cre.tar.gz -C /usr/local/bin \
    && mv /usr/local/bin/cre_v1.33.0_linux_amd64 /usr/local/bin/cre \
    && chmod 0755 /usr/local/bin/cre \
    && rm /tmp/cre.tar.gz

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

COPY orchestrator/package.json orchestrator/package.json
RUN cd /workspace/orchestrator \
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && ln -s /workspace/orchestrator/node_modules /workspace/node_modules

# The Builder is TypeScript-first and uses Node's built-in erasable type
# stripping. Keep the workspace packages in the image and expose them through
# the same package names used by local pnpm development.
COPY packages/strategy-builder/package.json packages/strategy-builder/package.json
COPY packages/strategy-builder/src packages/strategy-builder/src
COPY packages/strategy-builder/profiles packages/strategy-builder/profiles
COPY packages/builder-service/package.json packages/builder-service/package.json
COPY packages/builder-service/src packages/builder-service/src
COPY packages/builder-service/migrations packages/builder-service/migrations
COPY contracts/aqua-executor/package.json contracts/aqua-executor/package.json
RUN mkdir -p /workspace/node_modules/@pintool \
    && ln -s /workspace/packages/strategy-builder /workspace/node_modules/@pintool/strategy-builder \
    && ln -s /workspace/contracts/aqua-executor /workspace/node_modules/aqua-executor

COPY orchestrator orchestrator
COPY shared shared
COPY contracts/aqua-executor/src contracts/aqua-executor/src
COPY contracts/aqua-executor/artifacts contracts/aqua-executor/artifacts
COPY contracts/aqua-executor/deployments/11155111.json contracts/aqua-executor/deployments/11155111.json
COPY docs/guard-report-v1 docs/guard-report-v1
COPY workflow workflow
RUN cd /workspace/workflow && bun install --frozen-lockfile
RUN cd /workspace/workflow && bun run typecheck
RUN mkdir -p /data/mandates /home/node/.cre \
    && touch /workspace/workflow/.env \
    && chown -R node:node /data /home/node/.cre \
    && chown -R node:node /workspace/workflow
WORKDIR /workspace/orchestrator
# Initialize the mounted data directory, then drop privileges in the entrypoint.
USER root
ENTRYPOINT ["./docker-entrypoint.sh"]
