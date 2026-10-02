# Data Contract and Privacy

Status: proposed contract. The reference allow-lists are in [collector/config/base.yaml](../collector/config/base.yaml) and are verified with synthetic canaries. Field availability in real Copilot exports, and backend mappings, require validation before real-user collection.

## Collection purpose

Support aggregate analysis of observed agent/tool usage, model consumption, latency, classified failures, and available feedback. Do not use these signals as individual productivity scores, proof of task completion, or evidence of financial savings.

The initial collection is metadata-only. Even metadata may be sensitive or linkable to a person; pseudonymous identifiers are not automatically anonymous.

## Proposed field classes

| Class | Candidate allowed data | Constraints |
|---|---|---|
| Provenance | Source, schema version, runtime, client/service version | Keep native runtime distinctions |
| Correlation | Trace/span/parent IDs and necessary conversation/window IDs | Retention-bound; not a stable unique-person identity |
| Operations | Approved operation, agent/tool identifier, model/provider, duration | Validate values as well as keys; user-defined names can contain sensitive text |
| Consumption | Input/output tokens and available cache/reasoning token counts | Missing is unknown, not zero; preserve semantics and units |
| Reliability | Classified error, cancellation, or unknown outcome | No raw exception messages, stack traces, or command text |
| Feedback | Supported acceptance/rejection and response-feedback categories | No edited source, paths, or captured response content |
| Grouping | Approved organization/cohort, environment, rollout ring, configuration version | Authorization-derived scope wins over client-supplied labels |

These are candidate classes, not permission to forward every `gen_ai.*` or vendor-prefixed field. Adopt explicit typed allow-lists for every signal and version.

## Excluded data

Do not retain prompts, model responses, system instructions, source code, document/file contents, tool arguments/results, tool schemas, terminal commands/output, file paths, raw repository URLs, branch names, account names, email addresses, OS usernames, machine names, credentials, or arbitrary free-form payloads.

Unknown fields and unsupported record shapes must be dropped or rejected without logging their values. Review span names, status descriptions, event attributes, links, resource/scope fields, and log bodies as well as the obvious content fields.

Disabling Copilot content and identity capture is necessary but not sufficient: other metadata, including repository context, can still be emitted. If prohibited data remains, add a local sanitizer before off-device export or stop collection until the data policy is explicitly revised.

## Configuration and preferences

The setup package must respect existing enterprise policy and user telemetry preferences. Test the interaction with `telemetry.telemetryLevel`; do not assume an independently configured exporter automatically follows another telemetry library's opt-out behavior.

User settings are not policy enforcement. Detect conflicting environment variables and settings that independently enable export, and verify effective behavior. Never enable content capture temporarily against real user work to troubleshoot the collector.

## Custom resource attributes

Proposed project-specific labels:

| Attribute | Meaning |
|---|---|
| `copilot_insights.organization.id` | Organization label; the reference collector overwrites any client value with its deployment setting |
| `copilot_insights.cohort.id` | Approved pilot/team cohort where assignment is accurate |
| `copilot_insights.config.version` | Setup/configuration revision |
| `copilot_insights.rollout.ring` | Lab, pilot, or another approved rollout group |

These are not built-in Copilot fields. Restrict length and allowed values, and do not place personal information into tags.

Fixed resource attributes label a configured runtime. They do not automatically follow the currently active project. Dynamic project attribution is a separate feature requiring a supported association between operation and workspace. Multiple windows, multi-root workspaces, worktrees, remote hosts, and non-Git folders need explicit behavior. Unknown context stays unattributed.

## Normalization example

The following is a fictitious analytics projection, not the wire OTLP format or a backend table schema:

```json
{
  "schemaVersion": "0.1-draft",
  "source": "copilot-otel",
  "organizationId": "org-example",
  "cohortId": "team-example",
  "operation": "chat",
  "model": "example-model",
  "durationMs": 840,
  "inputTokens": 1200,
  "outputTokens": 180
}
```

All organization-scoped queries must bind the stored scope to the authenticated ingestion context, not trust the example's client-provided field.

## Counting and correlation

- Select one canonical representation per measure. Do not count a model call again because a log record describes the same call.
- Do not add parent agent token totals to child model-call totals.
- Separate top-level requests from subagent work, and distinguish calls, conversations, and windows.
- Count actual tool executions, not available tool definitions or installed extensions.
- Count explicit verified skill invocations only; do not infer that every installed instruction was used.
- Preserve cancellation and unknown outcomes. Absence of an error is not proof that the user's goal was achieved.
- For trace-derived records, validate deduplication using authorized organization, source, trace ID, and span ID. Define metric temporality and log identity separately.
- Define retry/replay age, deduplication horizon, and restart behavior before release. Repeated ingestion must not silently inflate aggregates.
- Only join other telemetry sources through a verified correlation contract. Matching timestamps or similar tool names is not sufficient.
- Window/session counts are not unique-user counts. No stable cross-device personal identifier is proposed.

Tokens describe observed model consumption, not necessarily the user's subscription invoice. Any cost estimate must state its pricing assumptions and coverage.

## Retention and access

Each deployment must approve a numerical retention period, hosting region, access policy, deletion procedure, and budget before collecting real-user telemetry. Do not silently inherit unrelated workspace retention settings.

Start with aggregate views for authorized operators and teams. Diagnostic access must be restricted and audited; agree small-cohort suppression rules. Collection notice must explain purpose, fields, destination, retention, and how a pilot participant disables export.

Do not retain raw exports for later analysis. Limit approved retry-queue retention as well as backend retention, and include caches, aggregates, and incident artifacts in deletion planning.

## Privacy validation

Use disposable synthetic repositories and conversations in real candidate clients. Include unique canaries in prompts, paths, repository metadata, identities, arguments/results, exception text, and mock credentials.

Separately use OTLP fixtures to exercise unknown fields, malformed records, oversized/decompressed payloads, and alternate signal shapes. Fixtures do not replace native-client tests.

Decode and scan the sanitized outbound stream, downstream storage, persistent queues, and diagnostic logs. Zero prohibited canaries may appear beyond the approved local test boundary. Preserve sanitized pass/fail evidence rather than raw captures.

See [Security](../SECURITY.md) and the [rollout plan](rollout-plan.md) for ownership and release gates.