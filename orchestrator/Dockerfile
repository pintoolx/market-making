FROM oven/bun:1.4.2 AS bun-runtime

FROM node:22-bookworm-slim

ENV NODE_ENV=production
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
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY orchestrator orchestrator
COPY workflow workflow
RUN cd /workspace/workflow && bun install --frozen-lockfile
RUN mkdir -p /data/mandates /home/node/.cre \
    && touch /workspace/workflow/.env \
    && chown -R node:node /data /home/node/.cre \
    && chown node:node /workspace/workflow/.env
WORKDIR /workspace/orchestrator
USER node
ENTRYPOINT ["./docker-entrypoint.sh"]
