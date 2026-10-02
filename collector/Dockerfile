# Pinned by tag and digest. Update both together, then rerun scripts/verify.ps1 against the local quick start.
FROM otel/opentelemetry-collector-contrib:0.161.0@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1

LABEL org.opencontainers.image.source="https://github.com/microsoft/copilot-insights" \
      org.opencontainers.image.description="OpenTelemetry Collector with the Copilot Insights privacy pipeline" \
      org.opencontainers.image.licenses="MIT"

COPY config/ /etc/copilot-insights/

EXPOSE 4318 13133

# Default to the authenticated profile so an unconfigured deployment fails closed; the local quick start overrides it.
CMD ["--config=/etc/copilot-insights/base.yaml", "--config=/etc/copilot-insights/azure.yaml"]
