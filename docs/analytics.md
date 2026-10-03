# Local analytics and human review

The **Copilot Insights review workspace** turns sanitized telemetry into aggregate usage, model consumption, latency, reliability, and coverage views. It also provides an evidence-based human review queue. Aspire remains the separate diagnostic viewer for individual traces, metrics, and logs.

This is a **local evaluation application**, not a production analytics service. Its findings are deterministic rules, not AI-generated conclusions. No model API is called to compose them.

## Open the site

From the repository root, follow the [local quick start](../README.md#try-it-on-your-machine):

```powershell
docker compose -f deploy/local/compose.yaml up --build --detach
```

- Review workspace: `http://127.0.0.1:3000`.
- Aspire diagnostics: `http://127.0.0.1:18888`.
- The **Local collector** source is the default. It reads only this project's sanitized `deploy/local/.data/telemetry.jsonl` and never silently substitutes demo data.
- Choose **Synthetic demo** for a richer, independently generated example. Its banner explicitly identifies it as fictional. Demo records and review decisions are isolated from collector records and decisions.
- Use **Refresh data** after new telemetry arrives. Review snapshots do not shift automatically while a person is inspecting them.

Observe the **Local collector** baseline before running `./scripts/verify.ps1 -TimeoutSeconds 60`, then refresh and compare. This command posts synthetic OTLP fixtures directly; it does not launch Copilot or exercise VS Code. The separate **Synthetic demo** source never reflects collector or editor activity. Follow the [README's real-client exercise](../README.md#optional-connect-vs-code) to enable export explicitly, perform harmless Local Copilot actions, and compare again. Metric and feedback event values are inspectable in Aspire but are not added to the portal's span-derived totals.

No Node installation, package download, Azure account, editor-setting change, or real-client export is required on the host. The container uses a pinned Node runtime and has no application package dependencies. For development with Node 24+, `node apps/insights/server.mjs` also serves the site on loopback port 3000; do not use the same port as the running Compose service.

## What you can review

| View | Purpose |
|---|---|
| Overview | Top-level agent runs, observed model tokens, P95 model latency, explicit error rate, daily activity, model mix, and coverage |
| Review queue | Search signals, filter by review state, inspect the rule and supporting evidence, and save a local decision |
| Models & tools | Separate model consumption from actual tool executions; no cumulative-counter or parent-token double counting |
| Data quality | Reporting coverage, unknown outcomes, freshness, replay handling, deferred partial writes, excluded records, and source limitations |

The UI uses an original light-theme layout with blue accents, segmented time filters, tabbed navigation, compact cards, and an evidence drawer. All code, icons, and fictional examples in this project are independently implemented. No private source, branding assets, datasets, tenant identifiers, internal endpoints, or service integrations are bundled or imported.

### Human review workflow

1. Select a source and a 7, 14, or 30 UTC-day window.
2. Open a signal from the overview or review queue.
3. Read **Why it surfaced**, the observed measure, and the supporting evidence. At most eight matching spans are shown, with the total matching count stated.
4. Use **Needs review**, **Investigating**, **Reviewed**, or **Dismissed**, then select **Save decision**.
5. For collector-backed evidence, the trace shortcut opens the separate loopback Aspire viewer. Fictional demo spans do not have collector trace links.

The side panel is a native modal dialog; Escape closes it. Navigation tabs support arrow keys, Home, and End. The activity chart has an equivalent data table, and narrow layouts keep wide evidence tables inside horizontal scrolling containers. These features are not a full accessibility certification.

## Counting rules and limits

The adapter implements a local subset of the [data contract](data-contract.md#counting-and-correlation):

- Only `copilot-chat` service/scope records in the configured collector organization are projected. The default organization is `local-dev`. The local file is trusted as collector output, not as an authenticated remote ingestion interface.
- Only `invoke_agent`, `chat`, and `execute_tool` spans with valid correlation IDs and a usable timestamp are counted. Agent spans with a parent are reported separately from top-level runs.
- Replays are deduplicated by collector organization, service/scope, trace ID, and span ID across the current bounded file snapshot. If an identity has conflicting normalized values, all its variants are excluded and a finding is raised. There is no durable cross-file or cloud replay index.
- Token totals use model spans only. Input and output counts must be nonnegative safe integers. Missing counts remain unknown. The total is the sum of **observed** counts, potentially partial, with complete-pair coverage shown separately; it is not an invoice or a cost estimate. Unrepresentable aggregate totals fail closed.
- Duration is end minus start in milliseconds. Missing or negative durations are unknown. P95 uses nearest rank on available durations; fewer than 20 model calls are labeled as a small sample.
- Explicit error, cancellation, OK, and unknown outcomes remain distinct. Error rate is explicit errors divided by observed model calls, not an inferred success rate. None of these is proof of task completion or productivity.
- The time window begins at UTC midnight and includes the current partial UTC day. Future-dated spans are excluded. File-wide replay, metric-record, and log-record diagnostics are explicitly separate from windowed activity counts.
- Metric and feedback log values are **not** added to span-derived totals. Qualified metric temporality and feedback identity handling are still future work.
- The latest accepted span timestamp provides an activity-freshness indicator, not an ingestion-delay or service-health guarantee. Fifteen minutes without an accepted span can simply mean the source is idle.

Rules flag explicit model errors, P95 model latency above five seconds, incomplete token counts, unknown model outcomes, stale local data, and conflicting replays. These are transparent evaluation defaults, not production SLOs or statistical anomaly detection.

## Privacy and storage boundary

- The browser fetches only this application's same-origin API and static assets. There are no external fonts, trackers, remote scripts, private clients, uploads, or third-party runtime requests. A deliberate diagnostic link navigates to the separate local Aspire site.
- A second narrow projection discards resource identities, session/conversation identifiers, prompts, responses, code, log bodies, events, links, arbitrary attributes, raw error messages, and file paths. Only validated model/tool labels, operation measures, and necessary trace/span correlation reach the evidence UI. This projection does **not** qualify the entire upstream privacy pipeline.
- Static routes are explicitly allow-listed. The server cannot return the collector file, review state file, source modules, or arbitrary filesystem paths.
- Compose publishes the site only on `127.0.0.1:3000`. The container runs as a non-root user with a read-only root filesystem, dropped capabilities, and a read-only telemetry mount. Only its review-state volume is writable, alongside ephemeral `/tmp`.
- Review writes require the exact same origin, a per-process review token, an approved status, and the current evidence fingerprint and decision revision. Unknown fields, including free-text notes, are rejected. This protects the local workflow against cross-origin writes and stale decisions; it is **not** user authentication.
- Decisions contain only the fingerprint, source, fixed status, revision, and timestamp. They are stored atomically in the `insights-reviews` Compose volume and survive container recreation. The most recently updated 2,000 decisions are retained; this is a bounded evaluation store, not an immutable audit log. The native development mode keeps the file under Git-ignored `deploy/local/.data` instead.
- A decision belongs to the source, selected UTC window, and exact normalized evidence snapshot. New data or a changed window does not inherit an old approval. Demo data is date-relative and generated independently; its review identities change when its evidence changes.
- The collector JSONL snapshot is limited to 32 MiB. An unterminated final record is deferred until the next refresh. Malformed complete records, unreadable input, and numeric overflow fail closed with a generic error instead of misleading partial totals or source-content excerpts. Rotate oversized output deliberately; no raw data is uploaded elsewhere as a fallback.

Stop normally with `docker compose -f deploy/local/compose.yaml down`; it preserves review decisions and the collector file. Removing the review volume permanently deletes its decisions. No real-client telemetry or automatic client startup is enabled by the site.

**Do not expose this anonymous local service to a network or use it as a team authorization boundary.** Production use still needs server-side identity and organization/cohort authorization, an approved storage/query adapter, retention and access policy, cohort suppression, real-client qualification, complete privacy testing, and an audited shared review workflow. Existing [pipeline gaps](architecture.md#processing-pipeline) remain open.

Organization client deployment follows the [Intune production plan](intune-deployment.md), not employee-run setup scripts. Its managed package/authentication gates and the portal's shared-service authorization gates are separate work.

## Implementation and checks

- [Server](../apps/insights/server.mjs): local HTTP boundary, static allow-list, narrow API, and write validation.
- [Telemetry projection](../apps/insights/lib/telemetry.mjs) and [analytics](../apps/insights/lib/analytics.mjs): bounded JSONL snapshots, canonical aggregates, and rule-based findings.
- [Review store](../apps/insights/lib/reviews.mjs): atomic local decisions and revision conflicts.
- [Frontend](../apps/insights/public/): original HTML, CSS, JavaScript, and SVG; no third-party browser dependencies.
- [Regression tests](../apps/insights/tests/analytics.test.mjs): counting, unknown values, replay conflicts, source isolation, malformed input, projection canaries, storage failure, host/origin restrictions, body limits, and review persistence.

After building the Compose images, run the tests from the repository root:

```powershell
docker run --rm --network none --mount "type=bind,source=$PWD/apps/insights/tests,target=/app/tests,readonly" copilot-insights-review:local node --test
docker compose -f deploy/local/compose.yaml exec -T insights node --check public/app.js
```

With a local Node 24+ installation, `node --test apps/insights/tests/analytics.test.mjs` runs the same tests. CI also verifies that one collector fixture produces one model call, one top-level agent run, one tool execution, 1,380 observed tokens, and one intentional error in the analytics API, with no canary leakage.
