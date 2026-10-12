# One image for the collector, the insights portal, and the admin MCP server; COPILOT_INSIGHTS_ROLE selects what runs.
# Base images are pinned by tag and digest. Update both together, then rerun scripts/verify.ps1 against the local quick start.
FROM otel/opentelemetry-collector-contrib:0.162.0@sha256:39923a8e431bd1f57be82411999d389fcfe40857492e4365456d97a4c1f74be6 AS collector

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS web

WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY apps/insights/package.json apps/insights/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry=$NPM_REGISTRY
COPY apps/insights/lib/types.ts ./lib/
COPY apps/insights/web/ ./web/
RUN npm run build

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

LABEL org.opencontainers.image.source="https://github.com/microsoft/copilot-insights" \
      org.opencontainers.image.description="Copilot Insights: OpenTelemetry Collector privacy pipeline, insights portal, and admin MCP server" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT"

WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY apps/insights/package.json apps/insights/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=$NPM_REGISTRY && npm cache clean --force
COPY --from=collector /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY collector/config/ /etc/copilot-insights/
COPY apps/insights/server.ts apps/insights/start.ts apps/insights/healthcheck.ts ./
COPY apps/insights/lib/ ./lib/
COPY apps/insights/public/ ./public/
COPY --from=web /app/dist/web/ ./dist/web/
RUN mkdir /app/state /data && chown node:node /app/state /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CI_LOCAL_OUTPUT_PATH=/data/vscode-telemetry.jsonl \
    CI_LOCAL_METRICS_OUTPUT_PATH=/data/vscode-metrics.jsonl \
    INSIGHTS_TELEMETRY_PATH=/data/vscode-telemetry.jsonl \
    INSIGHTS_REVIEW_PATH=/app/state/reviews.json

USER node
EXPOSE 4318 8080 13133
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD ["node", "healthcheck.ts"]
CMD ["node", "start.ts"]
