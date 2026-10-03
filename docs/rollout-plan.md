# Implementation and Rollout Plan

Status: draft. No pilot, deployment, or public release is approved by this document.

## Current status

This table compares the repository with the milestones below. It is the place to look for what is done and what is still missing.

| Milestone | State | Delivered | Still open |
|---|---|---|---|
| M0: Feasibility | In progress | Source/guide checks, synthetic privacy tests, and one native Windows Local Copilot capture/restore test ([evidence](local-validation.md#native-client-emission-and-restoration)); diagnostic forwarder with Azure CLI tokens | Broader runtime/version and privacy qualification; production authentication; operating budgets |
| M1: Receiver | Mostly implemented | Pinned collector, Entra ID token validation, privacy pipeline with value validation, managed identity exporter, private network template, CI, and an isolated running collector ([scoped evidence](azure-validation.md)) | Authenticated cloud ingress and durable-storage probes; rate limits; export queue health and persistence |
| M2: Intune-managed client | Plan defined; diagnostics implemented | [Intune production plan](intune-deployment.md); Windows diagnostic setup/forwarder; temporary local override and byte-exact [restore](../scripts/restore-client.ps1) with tests | Signed Intune package; managed policy/startup/detection/remediation/rollback; supported production credential lifecycle |
| M3: Analytics | Local evaluation implemented | [Local review workspace](analytics.md): bounded collector-file projection, aggregate views, deterministic findings, coverage/freshness, and persistent local decisions with regression tests | Verified cloud backend mapping, authorized query adapter, shared authentication, production counting/retention policy, and audited team review |
| M4: Opt-in pilot | Not started | | Cohort, collection notice, support owner, daily review |
| M5: Initial release | Not started | License, documentation, CI | Signed image and release provenance, support matrix, release notes |

## First delivery

Build a small, independently deployable system with **Microsoft Intune as the organization production deployment path**. Endpoint administrators assign the managed client and policy to staged device groups and own its lifecycle. Local scripts support development and controlled administrator diagnostics only; employees are not asked to run setup, startup, or rollback commands.

Use the [architecture](architecture.md) and [data contract](data-contract.md) as reviewed implementation inputs. Keep deployment-specific hosts, organization identifiers, and credentials outside the public repository.

## Proposed milestones

| Milestone | Deliverables | Exit gate |
|---|---|---|
| M0: Feasibility | Supported runtime/version matrix; native sample exports distinct from synthetic protocol fixtures; privacy results; authentication decision; approved fields and operating budgets | No assumptions about credentials, source filtering, or field coverage remain unresolved for the selected pilot |
| M1: Receiver | Pinned collector distribution; authenticated HTTPS routing; limits, filtering, export, queue health, and a synthetic storage probe | Valid test data reaches approved storage; invalid/unauthorized/prohibited data does not |
| M2: Intune-managed client | Signed Win32 package; complete managed policy; automatic lifecycle; detection/remediation; supported authentication; staged assignment and rollback | Managed deployment, upgrades, restart/recovery, and uninstall work without employee scripts, credential distribution, or damage to user work |
| M3: Analytics | Verified backend mapping, source-specific query adapter, aggregate views, coverage/freshness indicators | Golden fixtures produce expected counts; access restrictions and unknown states are correct |
| M4: Opt-in pilot | Named participating teams, collection notice, support owner, daily privacy/reliability/cost review | All pilot criteria pass over the agreed observation window |
| M5: Initial release | Reviewed source/docs, license, package provenance, deployment/runbook, support matrix, release notes | Maintainers and the hosting organization approve publication; no internal content or credentials are present |
| Later: Additional runtimes/platforms | Separately qualified Agent Host, CLI, remote hosts, and non-Windows forwarders | Same privacy/authentication/counting gates plus platform-specific managed deployment and migration tests |

Assign accountable owners for client engineering, ingestion/storage, analytics, security/privacy, operations, and release coordination before M0 exits. Dates and effort estimates follow feasibility; no delivery date is committed here.

## Managed deployment and diagnostic scripts

The [Intune plan](intune-deployment.md) is the required production path. It covers Copilot native MDM policy, signed packaging, managed startup, health reporting/remediation, execution context, authentication, and central rollback. These fleet components are not yet implemented; the [client guide](client-setup.md) describes the intended managed experience.

The existing [setup script](../scripts/setup-client.ps1) is a **local/administrator diagnostic reference**, not the package employees run:

| Operation | Implemented behavior |
|---|---|
| Install | Refuses to continue when VS Code telemetry is off or the user already configures Copilot OpenTelemetry. Warns about environment variables and policy values that override settings. Checks that Azure CLI can get an ingestion token, installs the checksum-verified collector, adds the settings block, and starts the forwarder. Idempotent. |
| Start | Starts the forwarder if it is not already healthy. Its settings are passed only to the forwarder process. |
| Stop | Stops this diagnostic forwarder. Copilot and independently configured telemetry are unaffected. |
| Status | Shows mode, settings block, telemetry level, overrides, forwarder health, token availability, and recent forwarder errors. Exits with 1 when something needs attention. |
| Uninstall | Stops the forwarder, removes exactly the settings block, and deletes the installed files. |
| Install -Local -Temporary / Restore | Permits an existing user OTel configuration for a loopback-only test, with content/identity off. Saves original settings bytes privately; restores them and removes the snapshot only if hashes prove no concurrent edits would be overwritten. |

Every operation supports `-WhatIf`. Ordinary install preserves settings outside its marked block. Temporary install serializes the settings object, then restores original comments/formatting/encoding byte for byte; keep its full-settings snapshot outside source control. It rejects disabled telemetry, managed-policy conflicts, unsafe routing overrides, and an existing managed installation. Cohort labels are settings rather than process-wide environment variables.

Do not wrap the diagnostic script in Intune and assume it is production-ready. Its per-user Azure CLI tokens do not work merely because an installer runs as `SYSTEM`; a supported credential lifecycle and unattended startup/recovery are blocking release gates.

### Generated settings

This is the **diagnostic** user-settings block that ordinary Install adds. Organization production uses the [managed telemetry baseline](intune-deployment.md#managed-configuration), not employee-edited settings:

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

Use Intune-enrolled Windows devices and an explicitly assigned pilot group. Endpoint administrators maintain the package, policy/configuration versions, automatic lifecycle, health reports, update deadlines, and centralized disable/uninstall path. A named pilot owner supplies the collection notice and support process. No employee-run setup package is part of enrollment.

### Acceptance criteria

1. **Privacy:** no prohibited synthetic canary leaves the approved local boundary or appears in backend storage, queues, or logs.
2. **Authentication:** enrollment, renewal, expiry, revocation, and organization isolation work for every included runtime; no anonymous fallback or shared fleet secret.
3. **Delivery:** expected synthetic operations reach storage within the approved numerical delivery target; drops, offline clients, and unsupported signals are visible.
4. **Correctness:** calls, tokens, feedback, and durations match golden sequences despite retries, nested operations, restarts, cancellation, and missing fields.
5. **Reversibility:** Intune deployment can be repeated, upgraded, disabled, rolled back, and uninstalled without damaging existing settings or user work; interrupted local tests can also be restored safely.
6. **User experience:** collector failures, rate limits, and lost credentials do not prevent normal Copilot use; measured overhead remains within approved budgets.
7. **Operations:** service owners can see failures and cost trends and have demonstrated emergency containment and deletion procedures.

Do not expand the pilot while a privacy/authentication gate or operating budget remains unresolved. Changing the collection purpose or introducing identity/content capture requires a separate proposal.

## Test matrix

Test native exporters as well as protocol fixtures. Include fresh and already-running editors, repeated setup, user edits after setup, multiple windows, existing policy, environment overrides, offline/reconnect, updates, rollback, helper failure, credential renewal, compression, oversized records, and backend delay.

Record tested version, runtime, configuration version, signal coverage, auth result, privacy result, and destination class. Evidence must not include real conversation content, access tokens, or unrestricted diagnostic reports.

For storage adapters, verify resource tags, trace-parent relationships, numeric token fields, metric aggregation, duplicate handling, and expected query tables. Demonstrate the difference between receiver acceptance and durable query visibility.

## Rollback and incident response

1. Revoke or reject the affected enrollment at ingestion for immediate containment; do not wait for a user to rerun setup.
2. Use Intune to disable the owned telemetry policy and forwarder/startup path, then roll back or uninstall the package. Remove conflicting install assignments before uninstall; plan any editor reload without losing user work. Do not depend on employee-run scripts or a device check-in for immediate ingestion containment.
3. Stop persistence/export of the affected source and discard unapproved queued records. Preserve only approved sanitized incident evidence.
4. Disable analytics independently if needed; hiding a dashboard does not stop collection.
5. Verify uploads have stopped while normal development still works, then apply the approved deletion procedure to disallowed data and derived copies.

Offline participants must update and requalify before enrollment is restored. Retest after client/collector releases change schemas or authentication behavior.

## Open decisions

- Exact supported client versions and runtime scope.
- Production credential flow: the diagnostic forwarder uses Azure CLI tokens; implement and qualify the chosen managed runtime identity/token lifecycle before Intune production assignment.
- Intune package and lifecycle implementation, initial storage backend, and regional requirements. Intune is the deployment decision, not an optional later phase.
- Approved retention, access, small-cohort suppression, and budget limits.
- Production hosting and authorization for the local analytics UX versus integration with an existing team visualization tool.
- Release ownership, hosting-organization requirements, and maintainer support commitments.

Automatic current-project attribution is intentionally deferred. Static tags are useful for cohorts but do not establish which project an operation belongs to.

## References

- [Copilot OTel configuration](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
- [Enterprise-managed telemetry configuration](https://code.visualstudio.com/docs/enterprise/manage-ai-settings#_configure-telemetry-export-with-opentelemetry)
- [Collector deployment guidance](https://opentelemetry.io/docs/collector/deployment/)
