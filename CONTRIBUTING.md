# Contributing

Copilot Insights is currently a documentation-first project. Contributions should improve the design, make assumptions testable, or prepare a narrowly scoped implementation milestone. Do not describe planned components as shipped features.

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

There is no implementation test suite or installable package yet. Future code must introduce focused tests for its behavior, especially privacy filtering, authentication, safe setup/restore, and counting correctness.

## Security and conduct

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

Participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Contributions must be compatible with the repository's [MIT license](LICENSE).