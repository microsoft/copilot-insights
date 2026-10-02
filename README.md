# Copilot Insights

An early-stage design for privacy-conscious observability of GitHub Copilot agent usage in Visual Studio Code, built around OpenTelemetry.

**Status: documentation and design only.** There is no implemented setup script, collector deployment, authentication helper, or dashboard in this repository yet. Configuration examples describe a proposed system, not a running service or a guarantee of support for a particular client release.

## Purpose

Help development teams understand observed agent and tool activity, model usage, token consumption, latency, and reliability without routing model traffic through an analytics service.

The proposed system uses Copilot's documented OpenTelemetry export as an additional observability source. Model requests continue to use their existing provider endpoint. Telemetry is sent separately to a collector operated by the adopting organization.

## Initial scope

- An opt-in, user-run setup experience for a supported Windows development environment.
- Metadata-only traces, metrics, and events with a reviewed data contract.
- An authenticated OTLP/HTTP ingestion path and a standard OpenTelemetry Collector.
- Aggregate usage and operational analytics with explicit coverage and freshness indicators.
- Pluggable storage through supported collector exporters; Azure Monitor is one reference option.

The first release does not include prompt or response capture, source code collection, individual productivity scoring, universal skill attribution, or automatic current-project tagging. Central device management is a later deployment option, not a prerequisite for the pilot.

## Design principles

1. **Do not intercept model traffic.** The collector receives telemetry, not inference requests.
2. **Minimize data before export.** Disabling content capture does not remove every potentially sensitive metadata field. Add local filtering when required by the collection policy.
3. **Authenticate explicitly.** Setting an OTLP endpoint does not supply credentials. Credential provisioning and renewal are separate integration work.
4. **Count what is actually observed.** Separate parent and child operations, retries, missing signals, and unsupported runtimes.
5. **Keep telemetry non-blocking.** Unavailable telemetry must not prevent normal development work.
6. **Make setup reversible.** Preserve unrelated editor settings and existing telemetry destinations.

## Getting started

This repository is not installable yet. Begin with a synthetic-data feasibility study on explicitly selected VS Code and Copilot versions. Do not enable collection from real users until authentication, pre-export filtering, storage access, retention, and collection notice have passed review.

Examples use reserved example domains and fictitious identifiers. Replace them only in an approved deployment configuration, never with credentials committed to the repository.

## Documentation

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | Client, authentication, collection, storage, and query boundaries |
| [Data contract](docs/data-contract.md) | Proposed allowed fields, privacy controls, counting rules, and correlation |
| [Rollout plan](docs/rollout-plan.md) | Self-service setup, implementation milestones, validation, and rollback |
| [Contributing](CONTRIBUTING.md) | How to improve the proposal and prepare future implementation changes |
| [Security](SECURITY.md) | Security expectations and private vulnerability reporting |
| [Code of conduct](CODE_OF_CONDUCT.md) | Community participation expectations |
| [Support](SUPPORT.md) | Questions, issue reporting, and current support boundaries |

## Project maturity

Public documentation establishes that Copilot can export OTel signals and custom resource attributes. This project has not yet validated an end-to-end implementation, credential lifecycle, privacy filter, storage mapping, or supported-version matrix. Those are milestone requirements, not completed features.

The initial repository is prepared for private review before an open-source release. Repository visibility, organization approval, and release readiness are separate from the choice of license.

## Public references

- [Monitor agent usage with OpenTelemetry](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

## Contributing

This project welcomes contributions and suggestions. Most contributions require agreement to a Contributor License Agreement (CLA) declaring that you have the right to grant the rights to your contribution. See [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, the CLA bot determines whether a CLA is required and provides instructions. You only need to complete this once across repositories that use the same CLA process. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.

This project follows the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). See the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with questions.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to the [Microsoft Trademark and Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general). Modified versions must not cause confusion or imply Microsoft sponsorship. Third-party trademarks and logos remain subject to their respective policies.

## License

[MIT](LICENSE).