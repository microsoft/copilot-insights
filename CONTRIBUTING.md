# Contributing

Copilot Insights is an early-stage project with a reference collector, local quick start, client setup script, and Azure template. Contributions should improve the design, make assumptions testable, or deliver a narrowly scoped implementation milestone. Do not describe planned components as shipped features.

## Propose a change

1. Read the [architecture](docs/architecture.md), [data contract](docs/data-contract.md), and [rollout plan](docs/rollout-plan.md).
2. For a substantial feature or new collection field, open a discussion or issue describing the use case, data implications, and validation strategy before implementation.
3. Keep pull requests focused and explain what changed, why, and how it was checked.
4. Follow the repository's organization contribution requirements and maintainer review process.

Most contributions require a [Contributor License Agreement](https://cla.opensource.microsoft.com). The CLA bot on a pull request will indicate whether action is required; follow its instructions before requesting merge.

## Public-safe contributions

- Use synthetic examples, reserved example domains, and fictitious identifiers.
- Do not include private product names, internal URLs, customer data, tenant/subscription identifiers, credentials, or captured conversation content.
- Do not copy source or documentation from a private repository without explicit authorization and an appropriate license.
- Scrub screenshots, logs, configuration, commit messages, and issue text before submitting them.
- Never attach full authentication or editor diagnostic reports without reviewing their contents.

## Documentation checks

Before proposing documentation changes:

- Verify local links and code-fence structure.
- Parse JSON and other configuration examples with a suitable parser.
- Check the public sources for behavioral claims and record version limitations.
- Run `git diff --check`.
- Distinguish documented capability, observed test evidence, and a proposed design decision.

## Implementation checks

The [CI workflow](.github/workflows/ci.yml) runs these checks on every pull request. Run them locally first:

- For collector changes, run the local quick start and `./scripts/verify.ps1`. This injects synthetic fixtures, so do not run it during a native-client baseline/action comparison. To preserve native evidence, target a separate disposable collector with explicit `-Endpoint`, `-HealthEndpoint`, `-OutputPath`, `-MetricsPath`, and `-ExpectedOrganizationId` values. Add canary cases when allowing a new field or signal.
- For setup script changes, run `./scripts/tests/setup-client.tests.ps1`. It uses temporary files only.
- For telemetry verification changes, run `./scripts/tests/fixture-contract.tests.ps1`, `./scripts/tests/telemetry.tests.ps1`, and the local quick start verification. These check documented signal names/types, explicit synthetic provenance, partially written output, and malformed complete records. Fixture checks do not replace actions in a real Copilot client.
- For remote verification changes, run `./scripts/tests/remote-verify.tests.ps1`. Its mocked Azure CLI and HTTP boundary check explicit tenant selection, HTTPS-only transport, redirect refusal, and no anonymous fallback without contacting Azure. These unit tests do not qualify a live cloud deployment.
- For analytics or review changes, run all [service tests](docs/analytics.md#implementation-and-checks), the local quick start, and browser checks of both organizations, project partitions, correlation coverage, scoped review persistence, keyboard dialogs, and narrow layouts. Keep fictional fixtures independent; never add private datasets, assets, endpoints, or package registries. Local browser runtime requests must stay on the local origin; production sign-in may additionally contact Microsoft Entra.
- For project companion changes, run `npm --prefix extensions/project-context test`. Mocked VS Code APIs are not native multi-window evidence; follow the [maintainer qualification notes](extensions/project-context/README.md) separately with approved disposable workspaces and reversible settings.
- For authentication or admin MCP changes, run the signed-JWT/MCP service tests and `./scripts/tests/entra-access.tests.ps1`. Graph assignment tests are mocked and must not require tenant permissions. Record live Entra consent, token, assignment, and denial checks separately before production approval.
- For template changes, run `az bicep lint --file deploy/azure/main.bicep` with no warnings, then `./scripts/export-azure-template.ps1` to regenerate the standalone portal template. CI runs `./scripts/export-azure-template.ps1 -Check` and `./scripts/tests/azure-template.tests.ps1` to reject stale ARM JSON and regressions in private/TLS defaults. Never add real tenant, subscription, certificate, or deployment parameter values to the generated template.
- For development certificate changes, run `./scripts/tests/certificate.tests.ps1` on Windows. It creates/removes a disposable certificate but does not add trusted roots. The optional `-IncludeTrust` run changes only its generated certificate in `CurrentUser\Root`, can require a Windows confirmation dialog, and tests reversal; use it only in an explicitly approved interactive lab. Never automate approval of arbitrary certificates.
- Update the pinned image tag and digest together. When you change the collector version, also update the version and archive checksum in `scripts/setup-client.ps1`.

New components need focused tests for their behavior, especially authentication, safe setup and restore, and counting correctness.

## Security and conduct

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

Participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Contributions must be compatible with the repository's [MIT license](LICENSE).
