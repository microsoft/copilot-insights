# Pinned by tag and digest. Update both together, then rerun scripts/verify.ps1 against the local quick start.
FROM otel/opentelemetry-collector-contrib:0.161.0-386@sha256:76fd04f2d75922e93e447381bafcd0b78d24f1c5cdcc13f424d9a16f0342c087

LABEL org.opencontainers.image.source="https://github.com/microsoft/copilot-insights" \
      org.opencontainers.image.description="OpenTelemetry Collector with the Copilot Insights privacy pipeline" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT"

COPY config/ /etc/copilot-insights/

EXPOSE 4318 13133

# Default to the authenticated profile so an unconfigured deployment fails closed; the local quick start overrides it.
CMD ["--config=/etc/copilot-insights/base.yaml", "--config=/etc/copilot-insights/azure.yaml"]
