FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app
COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
RUN mkdir /app/state && chown node:node /app/state

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    INSIGHTS_TELEMETRY_PATH=/data/telemetry.jsonl \
    INSIGHTS_REVIEW_PATH=/app/state/reviews.json

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.mjs"]
