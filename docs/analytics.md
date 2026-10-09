# Analytics and human review

The **Copilot Insights review workspace** turns sanitized telemetry into aggregate usage, model consumption, latency, reliability, and coverage views. It also provides an evidence-based human review queue. Aspire remains the separate diagnostic viewer for individual traces, metrics, and logs.

This is an **evaluation application** with a local no-auth mode and a fail-closed [production Entra authorization mode](production-access.md), not a production-qualified analytics service. Its findings are deterministic rules, not AI-generated conclusions. No model API is called to compose them. A read-only [admin MCP server](admin-mcp.md) exposes the same reports.

## Open the site

From the repository root, follow the [local quick start](../README.md#try-it-on-your-machine):

```powershell
docker compose -f deploy/local/compose.yaml up --build --detach
```

- Review workspace: `http://127.0.0.1:3000`.
- Aspire diagnostics: `http://127.0.0.1:18888`.
- **Demo organization** (`synthetic-demo`) is the default in local mode. It is populated immediately with fictional examples generated on this machine, not collector or native-client telemetry. Production lists only the collected organization.
- Choose **My VS Code organization** (`local-vscode`) to inspect `deploy/local/.data/vscode-telemetry.jsonl`. It starts empty on a fresh installation and never silently substitutes demo data. Old `telemetry.jsonl` captures are not imported. The collector writes metrics to a separate, rotated `vscode-metrics.jsonl`, which the portal does not read.
- Choose **Project** to view all, unattributed, or one selected project. [Window registrations](projects.md) supply context without modifying native Copilot events; missing settings do not imply a default project.
- Use **Refresh data** after new telemetry arrives. Review snapshots do not shift automatically while a person is inspecting them.

Follow the [three-step walkthrough](../README.md#try-it-on-your-machine): deploy and explore the demo organization, enable local logging for a disposable native VS Code/Copilot task, then switch to your local organization and compare with its baseline. Restore settings afterward. `verify.ps1` is a separate maintainer test that directly injects synthetic OTLP; it is not part of the native-client comparison. Metrics and feedback never inflate span-derived call/token totals.

`GET /api/organizations` returns the configured catalog. `GET /api/projects?organization=local-vscode` returns its project keys. Use `/api/insights?organization=local-vscode&project=unattributed&days=7` for a scoped report; an omitted project means `all`. Unknown, duplicate, cross-organization, or conflicting selectors fail closed. Existing `source=local` / `source=demo` bookmarks still work. Review requests include `organizationId` and `projectKey`, validated against the current evidence.

The collector's `CI_ORGANIZATION_ID` and portal's `INSIGHTS_ORGANIZATION_ID` must agree; both are `local-vscode` in Compose. `INSIGHTS_ORGANIZATION_NAME` is the display label. One service handles one collector organization plus, in local mode only, the fictional demo, not arbitrary tenants. Production authorizes administrators for that service organization; the selectors are not authorization boundaries. Never trust a client-supplied organization label.

No host Node installation or Azure account is required for local Docker evaluation. The image builds with pinned Node and npm dependencies; allow approved registry access during the build. MSAL is served from the image in production, not loaded from a CDN; local mode makes no Entra sign-in requests. For native Node development, run `npm ci` in `apps/insights` before `npm start`; avoid the Compose port if it is already running.

## What you can review

| View | Purpose |
|---|---|
| Overview | Top-level agent runs, observed model tokens, P95 model latency, explicit error rate, daily activity, model mix, and coverage |
| Review queue | Search signals, filter by review state, inspect the rule and supporting evidence, and save a local decision |
| Models & tools | Separate model consumption from actual tool executions; no cumulative-counter or parent-token double counting |
| Data quality | Reporting coverage, unknown outcomes, freshness, per-organization correlation, replay handling, deferred partial writes, and source limitations |

The UI uses an original light-theme layout with blue accents, segmented time filters, tabbed navigation, compact cards, and an evidence drawer. All code, icons, and fictional examples in this project are independently implemented. No private source, branding assets, datasets, tenant identifiers, internal endpoints, or service integrations are bundled or imported.

### Human review workflow

1. Select an organization, project filter, and a 7, 14, or 30 UTC-day window.
2. Open a signal from the overview or review queue.
3. Read **Why it surfaced**, the observed measure, and the supporting evidence. At most eight matching spans are shown, with the total matching count stated.
4. Use **Needs review**, **Investigating**, **Reviewed**, or **Dismissed**, then select **Save decision**.
5. Expand **IDs & trace** to inspect trace, span, parent, conversation, window/session, and tool-call IDs. For collector-backed evidence, the trace shortcut opens the separate loopback Aspire viewer. Fictional demo spans do not have collector trace links.

The side panel is a native modal dialog; Escape closes it. Navigation tabs support arrow keys, Home, and End. The activity chart has an equivalent data table, and narrow layouts keep wide evidence tables inside horizontal scrolling containers. These features are not a full accessibility certification.

## Counting rules and limits

The adapter implements a local subset of the [data contract](data-contract.md#counting-and-correlation):

- Only `copilot-chat` service/scope records in the selected configured organization are projected. The collector organization is `local-vscode`; the independent demo is `synthetic-demo`. Other organizations' records do not affect selected totals, diagnostics, or signal IDs. The local file is trusted as collector output, not as an authenticated remote ingestion interface.
- Only `invoke_agent`, `chat`, and `execute_tool` spans with valid correlation IDs and a usable timestamp are counted. Agent spans with a parent are reported separately from top-level runs.
- Replays are deduplicated by collector organization, service/scope, trace ID, and span ID across the current capture file. If an identity has conflicting normalized values, all its variants are excluded and a finding is raised. There is no durable cross-file or cloud replay index.
- Token totals use model spans only. Input and output counts must be nonnegative safe integers. Missing counts remain unknown. The total is the sum of **observed** counts, potentially partial, with complete-pair coverage shown separately; it is not an invoice or a cost estimate. Unrepresentable aggregate totals fail closed.
- Duration is end minus start in milliseconds. Missing or negative durations are unknown. P95 uses nearest rank on available durations; fewer than 20 model calls are labeled as a small sample.
- Explicit error, cancellation, OK, and unknown outcomes remain distinct. Error rate is explicit errors divided by observed model calls, not an inferred success rate. None of these is proof of task completion or productivity.
- The time window begins at UTC midnight and includes the current partial UTC day. Future-dated spans are excluded. File-wide replay, metric-record, and log-record diagnostics are explicitly separate from windowed activity counts.
- Metric and feedback log values are **not** added to span-derived totals. Qualified metric temporality and feedback identity handling are still future work.
- The latest accepted span timestamp provides an activity-freshness indicator, not an ingestion-delay or service-health guarantee. Fifteen minutes without an accepted span can simply mean the source is idle.

Rules flag explicit model errors, P95 model latency above five seconds, incomplete token counts, unknown model outcomes, stale local data, and conflicting replays. These are transparent evaluation defaults, not production SLOs or statistical anomaly detection.

## Correlation IDs

The [VS Code telemetry guide](https://code.visualstudio.com/docs/agents/guides/monitoring-agents#_what-gets-collected) describes the native signals. The collector preserves supported identifiers; it does not generate missing client correlation IDs or treat a window as a person. **Data quality** summarizes their coverage, and **IDs & trace** expands identifiers on individual evidence rows.

| Identifier | Origin and use |
|---|---|
| `copilot_insights.organization.id` | Assigned by the collector's trusted `CI_ORGANIZATION_ID`, replacing any client value. Local Compose uses `local-vscode`; the fictional generator uses `synthetic-demo`. |
| OTLP `traceId`, `spanId`, `parentSpanId` | Native trace tree. A child is linked only to an observed parent in the same trace and selected window. Valid trace links open the separate local Aspire viewer. |
| `gen_ai.conversation.id` | Native conversation correlation on spans. A conversation can cover several traces; auxiliary spans may omit it. |
| Resource `session.id` | Native VS Code window identifier, not a user or organizational membership. |
| `gen_ai.tool.call.id` | Native tool-call identifier when present. Empty or missing values stay absent. |
| Feedback `conversation_id` | Native feedback correlation. When no trace is supplied, feedback joins by conversation and, when present, window/session. A supplied trace/span must match exactly; malformed supplied trace IDs cannot fall back to a conversation join. |

All joins are scoped to the selected organization and UTC window. Identical feedback projections are deduplicated. Feedback and cumulative metric records do not increase model-call, tool-call, or token totals. The **October 3 organization walkthrough** in the [local validation record](local-validation.md#organization-walkthrough) demonstrates a native parent/child trace and feedback correlation without a fabricated trace ID. Missing parents, conversations, or tool-call IDs remain visible coverage limits rather than invented links.

These are pseudonymous diagnostic identifiers, not authorization claims. The catalog separates the two evaluation datasets; the selector does not grant access or implement organization enrollment. Production APIs require an assigned Entra admin for the service's configured organization. Production ingestion routing must derive organization from an authenticated, administrator-controlled boundary, not a browser selection or untrusted client attribute.

## Privacy and storage boundary

- In local mode, browser runtime requests stay on this application's origin. A deliberate diagnostic link navigates to the separate local Aspire site. Production sign-in additionally contacts Microsoft Entra; scripts, fonts, and other portal assets remain locally served. Neither mode loads trackers, private clients, or third-party CDN scripts.
- A second narrow projection discards user/account identities, prompts, responses, code, log bodies, events, links, arbitrary attributes, raw error messages, and file paths. Only validated model/tool labels, operation measures, and validated trace/span, conversation, window/session, and tool-call identifiers reach the evidence UI. Correlation identifiers remain potentially sensitive diagnostic metadata, not proof of an anonymous dataset. This projection does **not** qualify the entire upstream privacy pipeline.
- Static routes are explicitly allow-listed. The server cannot return the collector file, review state file, source modules, or arbitrary filesystem paths.
- Compose publishes the site only on `127.0.0.1:3000`. The container runs as a non-root user with a read-only root filesystem, dropped capabilities, and a read-only telemetry mount. Only its review-state volume is writable, alongside ephemeral `/tmp`.
- Review writes require the exact same origin, a per-process review token, an approved status, a signal that still applies in the selected scope, and the current decision revision. Unknown fields, including free-text notes, are rejected. This protects the local workflow against cross-origin writes and stale decisions; it is **not** user authentication.
- Decisions contain only the signal ID, organization ID, project key, source, fixed status, revision, timestamp, and the evidence count and newest evidence time seen when the decision was saved. They are stored atomically in the `insights-reviews` volume alongside the separate window registry. The latest 2,000 decisions are retained; this is not an immutable audit log. Native Node development uses ignored `deploy/local/.data` storage. Legacy decisions remain stored without silently acquiring organization/project scope or matching the current signal IDs.
- A signal ID combines the organization, project filter, source, window length, and rule, so a decision survives refreshes and UTC day changes. Evidence that is newer or more numerous than at decision time marks it **New evidence since review** rather than resetting it; saving again records the current evidence. Another scope (including all projects) or window length cannot inherit an old decision. Demo evidence is date-relative and independent of native activity.
- Each refresh parses only records appended since the previous one; a truncated, rewritten, or replaced file is read again from the start. The input is limited to 256 MiB; archive the capture file when it approaches that size. An unterminated final record is deferred until the next refresh. Malformed complete records, unreadable input, and numeric overflow fail closed with a generic error instead of misleading partial totals or source-content excerpts. No raw data is uploaded elsewhere as a fallback.

Stop normally with `docker compose -f deploy/local/compose.yaml down`; it preserves review decisions, window registrations, and the collector file. Removing the review-state volume permanently deletes its decisions and window-to-project attribution. Back up the registry with its telemetry before removing or archiving state. No real-client telemetry or automatic client startup is enabled by the site.

**Do not expose local no-auth mode to a network.** [Production mode](production-access.md) validates Entra signatures, issuer/tenant, audience, lifetime, access-token claims, scopes, and app roles for every report/review/MCP request. It still needs live tenant qualification, approved production storage, retention/access policy, cohort suppression, native runtime qualification, full privacy testing, and an audited review workflow. Per-project admin ACLs are not implemented. Existing [pipeline gaps](architecture.md#processing-pipeline) remain open.

In Azure, the portal reads the collector's export from the usage Log Analytics workspace instead of a file ([deployment](infrastructure.md#deploy-from-your-checkout)). Stored rows are converted back to the same records and pass through the same normalization, so the counting rules above apply unchanged. Replay detection, metric, and log diagnostics cover the last 32 days rather than a file. A partial query result fails closed. This mapping is tested against the pinned exporter's behavior but not yet against a live workspace.

Organization deployment follows the [Intune plan](intune-deployment.md), not employee-run scripts. Its managed package and renewable ingestion authentication gates are distinct from this portal/MCP authorization implementation.

## Implementation and checks

- [Server](../apps/insights/server.mjs): local HTTP boundary, static allow-list, narrow API, and write validation.
- [Telemetry projection](../apps/insights/lib/telemetry.mjs) and [analytics](../apps/insights/lib/analytics.mjs): incremental JSONL reading, canonical aggregates, and rule-based findings.
- [Log Analytics source](../apps/insights/lib/loganalytics.mjs): managed-identity queries of the usage workspace for Azure deployments.
- [Review store](../apps/insights/lib/reviews.mjs): atomic local decisions and revision conflicts.
- [Frontend](../apps/insights/public/): original HTML/CSS/JavaScript/SVG; production sign-in uses locally served MSAL.
- [Window registry](../apps/insights/lib/context.mjs), [authorization](../apps/insights/lib/auth.mjs), and [MCP](../apps/insights/lib/mcp.mjs): project attribution and role-protected reports.
- [Regression tests](../apps/insights/tests/): counting, unknown values, replay conflicts, source/project isolation, projection canaries, registration lifecycle, signed-token authorization, MCP clients, host/origin restrictions, and review persistence.

After building the Compose images, run the tests from the repository root:

```powershell
docker run --rm --network none --mount "type=bind,source=$PWD/apps/insights/tests,target=/app/tests,readonly" copilot-insights-review:local node --test
docker compose -f deploy/local/compose.yaml exec -T insights node --check public/app.js
```

With a local Node 24+ installation, run `npm --prefix apps/insights ci --ignore-scripts` once, then `npm --prefix apps/insights test` for all service suites. Run `npm --prefix extensions/project-context test` for the isolated extension tests and `./scripts/tests/entra-access.tests.ps1` for mocked role-assignment checks. CI also verifies that one collector fixture produces one model call, one top-level agent run, one tool execution, 1,380 observed tokens, and one intentional error in the analytics API, with no canary leakage. Neither generated-token tests nor mocked Graph responses prove live Entra sign-in or role assignment.
