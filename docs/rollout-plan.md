# Implementation and Rollout Plan

Status: draft. No pilot, deployment, or public release is approved by this document.

## Current status

This table compares the repository with the milestones below. It is the place to look for what is done and what is still missing.

| Milestone | State | Delivered | Still open |
|---|---|---|---|
| M0: Feasibility | In progress | Copilot export behavior checked against its source and documentation: settings precedence, the telemetry kill switch, emitted fields. Privacy results with synthetic telemetry. Pilot authentication decision: a local forwarder with Azure CLI tokens. | Exports from real Copilot clients; supported-version matrix; operating budgets |
| M1: Receiver | Mostly implemented | Pinned collector, Entra ID token validation, privacy pipeline with value validation, managed identity export to Application Insights, private network template, CI | Deployment in a subscription and a storage probe; rate limits; export queue health and persistence |
| M2: Self-service setup | Implemented for Windows | [setup-client.ps1](../scripts/setup-client.ps1) with install, start, stop, status, and uninstall; local forwarder with on-device filtering and token renewal; tests | Start at sign-in; forwarder on macOS and Linux; a credential flow that does not depend on Azure CLI |
| M3: Analytics | Not started | | Verified backend mapping, query adapter, aggregate views, coverage and freshness indicators |
| M4: Opt-in pilot | Not started | | Cohort, collection notice, support owner, daily review |
| M5: Initial release | Not started | License, documentation, CI | Signed image and release provenance, support matrix, release notes |

## First delivery

Build a small, independently deployable system that a participant can configure on a development machine with a user-run setup package. Central device management is deliberately deferred until the self-service path is proven.

Use the [architecture](architecture.md) and [data contract](data-contract.md) as reviewed implementation inputs. Keep deployment-specific hosts, organization identifiers, and credentials outside the public repository.

## Proposed milestones

| Milestone | Deliverables | Exit gate |
|---|---|---|
| M0: Feasibility | Supported runtime/version matrix; native synthetic exports; privacy results; authentication decision; approved fields and operating budgets | No assumptions about credentials, source filtering, or field coverage remain unresolved for the selected pilot |
| M1: Receiver | Pinned collector distribution; authenticated HTTPS routing; limits, filtering, export, queue health, and a synthetic storage probe | Valid test data reaches approved storage; invalid/unauthorized/prohibited data does not |
| M2: Self-service setup | Configure, start, status, disable, and restore operations; versioned configuration; optional local helper | Idempotent non-admin setup works without overwriting user work or bypassing policy; required helper is ready |
| M3: Analytics | Verified backend mapping, source-specific query adapter, aggregate views, coverage/freshness indicators | Golden fixtures produce expected counts; access restrictions and unknown states are correct |
| M4: Opt-in pilot | Named participating teams, collection notice, support owner, daily privacy/reliability/cost review | All pilot criteria pass over the agreed observation window |
| M5: Initial release | Reviewed source/docs, license, package provenance, deployment/runbook, support matrix, release notes | Maintainers and the hosting organization approve publication; no internal content or credentials are present |
| Later: Fleet rollout | Optional managed configuration, staged cohorts, script-to-managed migration, new runtime qualification | Same privacy/authentication gates plus policy-delivery and migration tests |

Assign accountable owners for client engineering, ingestion/storage, analytics, security/privacy, operations, and release coordination before M0 exits. Dates and effort estimates follow feasibility; no delivery date is committed here.

## Self-service setup

Participants run [scripts/setup-client.ps1](../scripts/setup-client.ps1); the [client setup guide](client-setup.md) is written for them. It needs no administrator rights and no device management.

| Operation | Implemented behavior |
|---|---|
| Install | Refuses to continue when VS Code telemetry is off or the user already configures Copilot OpenTelemetry. Warns about environment variables and policy values that override settings. Checks that Azure CLI can get an ingestion token, installs the checksum-verified collector, adds the settings block, and starts the forwarder. Idempotent. |
| Start | Starts the forwarder if it is not already healthy. Its settings are passed only to the forwarder process. |
| Stop | Stops the forwarder. Copilot keeps working; nothing leaves the machine. |
| Status | Shows mode, settings block, telemetry level, overrides, forwarder health, token availability, and recent forwarder errors. Exits with 1 when something needs attention. |
| Uninstall | Stops the forwarder, removes exactly the settings block, and deletes the installed files. |

Every operation supports `-WhatIf`. The script edits the user's normal VS Code settings rather than a separate editor instance. The `github.copilot.chat.otel.resourceAttributes` setting carries the cohort labels, so no process environment variables are needed, and nothing leaks into agent tool processes. The block between marker comments makes the change exactly reversible; tests check byte-for-byte restoration.

Still required before a wider rollout: start at sign-in without a visible console, macOS and Linux forwarders, and qualification of Agent Host sessions, terminal CLI, and remote hosts, which use their own exporters.

### Generated settings

This is the block that Install adds, with the forwarder as the destination:

```jsonc
{
	/* >>> copilot-insights: managed by setup-client.ps1; remove with "setup-client.ps1 Uninstall" */
	"github.copilot.chat.otel.enabled": true,
	"github.copilot.chat.otel.exporterType": "otlp-http",
	"github.copilot.chat.otel.otlpEndpoint": "http://127.0.0.1:4319",
	"github.copilot.chat.otel.captureContent": false,
	"github.copilot.chat.otel.captureIdentity": false,
	"github.copilot.chat.otel.resourceAttributes": {"copilot_insights.config.version":"0.1.0","copilot_insights.rollout.ring":"pilot","copilot_insights.cohort.id":"team-a"},
	/* <<< copilot-insights */
	"editor.fontSize": 14
}
```

The settings contain no credentials. Enterprise policy, `COPILOT_OTEL_*` variables, and `OTEL_EXPORTER_OTLP_*` variables take precedence over these settings, and Copilot exports nothing while `telemetry.telemetryLevel` is `off`. The script reports all of these instead of overriding them.

The forwarder obtains tokens through Azure CLI and renews them automatically. Tokens never appear in VS Code settings, the editor's environment, or tool subprocesses. Local and Agent Host sessions, terminal CLI, remote hosts, and other operating systems each require their own compatibility results.

## Backend implementation requirements

- Provision a private collector behind an explicitly authenticated HTTPS route.
- Use approved pinned component/image versions and minimal required capabilities.
- Enforce the data contract before durable queues or storage, and validate organization scope from trusted enrollment.
- Prove the selected exporter maps each required signal and tag correctly.
- Keep system health telemetry separate from collected agent activity.
- Define maximum queue size/age, retry policy, durable-buffer requirements, and graceful-shutdown behavior.
- Approve numerical ingestion, storage/query cost, retention, latency, CPU, and memory budgets.
- Provide negative tests for wrong issuer/audience, expired/revoked credentials, cross-organization uploads, forged tags, malformed records, and resource exhaustion.

The analytics backend needs authorized queries, not a publicly exposed query credential. Do not treat a successful upload response as proof that data has become queryable.

## Pilot proposal

Start with a small explicitly enrolled cohort, such as five to ten participants from one or two teams, after laboratory gates pass. The final cohort and observation period require owner approval; these numbers are planning examples.

Participants run the setup package on their own development environments. A named pilot owner maintains enrollment, configuration versions, update deadlines, and an easy disable path. No device-management enrollment is required.

### Acceptance criteria

1. **Privacy:** no prohibited synthetic canary leaves the approved local boundary or appears in backend storage, queues, or logs.
2. **Authentication:** enrollment, renewal, expiry, revocation, and organization isolation work for every included runtime; no anonymous fallback or shared fleet secret.
3. **Delivery:** expected synthetic operations reach storage within the approved numerical delivery target; drops, offline clients, and unsupported signals are visible.
4. **Correctness:** calls, tokens, feedback, and durations match golden sequences despite retries, nested operations, restarts, cancellation, and missing fields.
5. **Reversibility:** setup can be rerun, upgraded, disabled, and restored without damaging existing settings or user work.
6. **User experience:** collector failures, rate limits, and lost credentials do not prevent normal Copilot use; measured overhead remains within approved budgets.
7. **Operations:** service owners can see failures and cost trends and have demonstrated emergency containment and deletion procedures.

Do not expand the pilot while a privacy/authentication gate or operating budget remains unresolved. Changing the collection purpose or introducing identity/content capture requires a separate proposal.

## Test matrix

Test native exporters as well as protocol fixtures. Include fresh and already-running editors, repeated setup, user edits after setup, multiple windows, existing policy, environment overrides, offline/reconnect, updates, rollback, helper failure, credential renewal, compression, oversized records, and backend delay.

Record tested version, runtime, configuration version, signal coverage, auth result, privacy result, and destination class. Evidence must not include real conversation content, access tokens, or unrestricted diagnostic reports.

For storage adapters, verify resource tags, trace-parent relationships, numeric token fields, metric aggregation, duplicate handling, and expected query tables. Demonstrate the difference between receiver acceptance and durable query visibility.

## Rollback and incident response

1. Revoke or reject the affected enrollment at ingestion for immediate containment; do not wait for a user to rerun setup.
2. Tell participants to run the disable operation and restart only the pilot instance as required. Remove all setup-owned activation paths, not merely one setting.
3. Stop persistence/export of the affected source and discard unapproved queued records. Preserve only approved sanitized incident evidence.
4. Disable analytics independently if needed; hiding a dashboard does not stop collection.
5. Verify uploads have stopped while normal development still works, then apply the approved deletion procedure to disallowed data and derived copies.

Offline participants must update and requalify before enrollment is restored. Retest after client/collector releases change schemas or authentication behavior.

## Open decisions

- Exact supported client versions and runtime scope.
- Production credential flow: the pilot forwarder uses Azure CLI tokens; a dedicated public client with broker sign-in could remove that dependency.
- Initial storage backend, deployment packaging, and regional requirements.
- Approved retention, access, small-cohort suppression, and budget limits.
- Analytics UI versus integration with an existing visualization tool for the first pilot.
- Release ownership, hosting-organization requirements, and maintainer support commitments.

Automatic current-project attribution is intentionally deferred. Static tags are useful for cohorts but do not establish which project an operation belongs to.

## References

- [Copilot OTel configuration](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
- [Enterprise-managed telemetry configuration](https://code.visualstudio.com/docs/enterprise/manage-ai-settings#_configure-telemetry-export-with-opentelemetry)
- [Collector deployment guidance](https://opentelemetry.io/docs/collector/deployment/)