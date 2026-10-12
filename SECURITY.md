<!-- BEGIN MICROSOFT SECURITY.MD V1.0.0 BLOCK -->

## Security

Microsoft takes the security of our software products and services seriously, which
includes all source code repositories in our GitHub organizations.

**Please do not report security vulnerabilities through public GitHub issues.**

For security reporting information, locations, contact information, and policies,
please review the latest guidance for Microsoft repositories at
[https://aka.ms/SECURITY.md](https://aka.ms/SECURITY.md).

<!-- END MICROSOFT SECURITY.MD BLOCK -->

## Project status

This repository contains an early reference implementation, not a supported release. No hosted endpoint, production-qualified release, or production-security guarantee is provided.

Organizations adopting a future implementation remain responsible for their collection approval, identity configuration, access controls, retention, and deployment security.

## Reporting a vulnerability

Do not disclose a vulnerability, credential, private telemetry, or exploit containing sensitive data in a public issue or pull request.

For security concerns in this Microsoft-hosted project, use the [Microsoft Security Response Center reporting portal](https://msrc.microsoft.com/create-report).

Include affected versions or documentation references, impact, and a minimal synthetic reproduction. Do not send unrelated user conversations, repositories, or secrets. Report vulnerabilities in upstream products to their respective maintainers.

## Design requirements

- Authenticated HTTPS for off-device ingestion; no trust based only on source IP or client-provided tags.
- Explicit credential issuance, renewal, revocation, and intended-audience validation.
- No shared long-lived fleet secret or credentials committed to configuration.
- Reviewed local filtering when prohibited fields must remain on-device.
- Server-side schema/value enforcement before durable storage.
- Limits on request size, decompression, attribute count/length, queue size, retries, and retention.
- Restricted, audited data access and no raw payload logging.
- Safe client setup that respects existing policy and can be disabled/restored.
- Signed or otherwise verifiably sourced release artifacts with pinned dependencies and documented update behavior.

See the [data contract](docs/data-contract.md) for the proposed collection policy and the [rollout plan](docs/rollout-plan.md) for release gates.