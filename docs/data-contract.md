# Data Contract and Privacy

Status: proposed contract with a reference implementation. The allow-lists below are enforced by [collector/config/base.yaml](../collector/config/base.yaml) on the participant's machine and on the server, and they are checked with synthetic canaries. Field names were checked against Copilot's published emitter source and monitoring documentation. One native Windows Local Copilot sample is verified; wider field coverage, privacy qualification, and backend mappings still require validation before real-user collection.

## Signal compatibility and fixture provenance

On October 2, 2026, the verification fixture's signal names and metric kinds were checked against [What gets collected](https://code.visualstudio.com/docs/agents/guides/monitoring-agents#_what-gets-collected), using the [published documentation snapshot](https://github.com/microsoft/vscode-docs/blob/8889b0542cb2144fb53f5f53bd19c1395e2d9fa1/docs/agents/guides/monitoring-agents.md). The public emitter's [metric definitions](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/otel/common/genAiMetrics.ts) and [event definitions](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/otel/common/genAiEvents.ts) were also inspected, including boolean tool-success values, the `event.name` log attribute, and feedback's `conversation_id` key.

| Fixture signal | Documented type | This project's treatment |
|---|---|---|
| `invoke_agent`, `chat`, `execute_tool` | Spans | Retain approved metadata; normalize names; analytics count model tokens only once |
| `gen_ai.client.operation.duration` | Histogram, seconds | Preserve histogram shape/unit; inspect in Aspire, not added to span totals |
| `gen_ai.client.token.usage` | Histogram, tokens | Preserve separate `gen_ai.token.type` input/output observations; not additional model calls |
| `copilot_chat.tool.call.count`, `copilot_chat.user.feedback.count` | Counters | Preserve cumulative monotonic OTLP Sums; do not sum repeated cumulative samples as new activity |
| `copilot_chat.user.feedback` | Event carried as an OTLP log record | Keep allowed attributes, clear the body; not a portal review decision |
| `execute_hook`, `gen_ai.client.inference.operation.details` | Documented span/event, respectively | Deliberately excluded by this project's narrower privacy contract |

The verifier additionally injects `example.unapproved.metric`, `CANARY-*` values, and unknown/private-shaped attributes as **negative controls**. These are not claimed to be native Copilot output. Its `service.version=0.0.0-verification` and `copilot_insights.config.version=verify-…` identify generated fixtures; the latter is a project-owned label, not a VS Code signal. Parent-agent token totals, child-model token totals, and independent histogram samples describe overlapping usage, not three different charges.

[Offline contract tests](../scripts/tests/fixture-contract.tests.ps1) check the selected names, OTLP types, units, correlation, and provenance without contacting a collector. The live [verification script](../scripts/verify.ps1) checks their sanitized output. These tests cover a documented subset, not every instrument or a complete emitter conformance suite. They do **not** run a Copilot process, establish real-client field availability, or qualify privacy for arbitrary native payloads. Actual Local Copilot actions and native trace provenance must be checked separately using the [README walkthrough](../README.md#optional-connect-vs-code).

Native evidence is separate from the fixture: the [October 3, 2026 UTC local test](local-validation.md#native-client-emission-and-restoration) used VS Code 1.140.0 / Copilot Chat 0.68.0, retained `copilot-chat` service/scope identity, and captured actual file/terminal tool spans, metric families, and a `copilot_chat.user.feedback` event correlated by `conversation_id`. No synthetic emitter ran during that comparison. It establishes the tested subset, not complete emitter conformance or production approval.

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

## Reference allow-lists

Everything not listed here is dropped. Scope attributes are always removed.

| Signal | Records kept | Attributes kept |
|---|---|---|
| Resource (all signals) | Not applicable | `service.name`, `service.version`, `session.id`, `copilot_insights.organization.id` (always set by the central collector), `copilot_insights.cohort.id`, `copilot_insights.config.version`, `copilot_insights.rollout.ring` |
| Spans | Operations `invoke_agent`, `chat`, and `execute_tool`. Span names are replaced by the operation name; span events and status messages are removed. | Operation, provider, agent name and type, conversation ID, request and response model, finish reasons, input, output, cache, and reasoning token counts, tool name, type, and call ID, edit type, skill name, hashed MCP server name, MCP tool name, turn count, time to first token, error type |
| Metrics | `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, and the `copilot_chat.` metrics for tool call count and duration, agent invocation duration, agent turn count, session count, time to first token, user feedback count, edit acceptance count, and chat edit outcome count | Operation, provider, agent name, request and response model, token type, tool name, `success`, `rating`, edit source, edit outcome, language ID, error type |
| Log events | `copilot_chat.user.feedback` and `copilot_chat.edit.feedback` only. Bodies are cleared. | `event.name`, `rating`, `outcome`, `language_id`, `edit_surface`, `participant`, `conversation_id`, `gen_ai.conversation.id` |

Copilot emits other log events, such as inference details, tool calls, and agent turns, but they describe the same operations as the spans. Keeping them would invite double counting, so only feedback events, which have no span equivalent, pass.

**Value rule.** A string attribute value is kept only if it starts with a letter or digit, contains only letters, digits, spaces, and `_ . : / + -`, does not contain `://`, and is at most 128 characters long. Anything else, such as an email address, a Windows path, a URL, or a sentence with punctuation, becomes `redacted`. The rule applies to resource, span, metric, and log attributes. It does not inspect values inside arrays.

## Excluded data

Do not retain prompts, model responses, system instructions, source code, document/file contents, tool arguments/results, tool schemas, terminal commands/output, file paths, raw repository URLs, branch names, account names, email addresses, OS usernames, machine names, credentials, or arbitrary free-form payloads.

Unknown fields and unsupported record shapes must be dropped or rejected without logging their values. Review span names, status descriptions, event attributes, links, resource/scope fields, and log bodies as well as the obvious content fields.

Disabling Copilot content and identity capture is necessary but not sufficient: other metadata, including repository context, can still be emitted. The forwarder therefore applies the allow-lists before off-device export. If prohibited data remains, stop collection until the data policy is explicitly revised.

## Configuration and preferences

Copilot resolves its OpenTelemetry configuration in this order: enterprise policy, then `COPILOT_OTEL_*` environment variables, then `OTEL_EXPORTER_OTLP_*` environment variables, then VS Code settings. It exports nothing while VS Code `telemetry.telemetryLevel` is `off`. The setup script respects that opt-out instead of changing it, refuses to replace a participant's own Copilot OpenTelemetry settings, and reports environment variables and policy values that would override its settings.

User settings are not policy enforcement. Verify effective behavior with the script's Status action. Never enable content capture temporarily against real user work to troubleshoot the collector.

## Custom resource attributes

Project-specific labels, set by the setup script through the `github.copilot.chat.otel.resourceAttributes` setting:

| Attribute | Meaning |
|---|---|
| `copilot_insights.organization.id` | Organization label; the forwarder removes any client value, and the central collector sets its deployment value |
| `copilot_insights.cohort.id` | Approved pilot/team cohort where assignment is accurate (`-Cohort`) |
| `copilot_insights.config.version` | Setup/configuration revision |
| `copilot_insights.rollout.ring` | `local`, `pilot`, or another approved rollout group (`-Ring`) |

These are not built-in Copilot fields. The setup script accepts only short identifier-like values, and the value rule applies to them as well. Do not place personal information into tags.

Fixed resource attributes label a configured runtime. They do not automatically follow the currently active project. The [project registration contract](projects.md) separately binds a native window ID to the project selected for the first workspace folder, without inventing or mutating Copilot OTLP fields. Multiple chats inherit their window's binding; a window's first project applies immediately, while later changes close the old binding and require a new window ID before work resumes. Missing or uncertain context stays unattributed. Remote hosts, shared-folder windows, clock boundaries, delayed export, and unsplittable metrics have explicit limits in that guide; native multi-window qualification remains required.

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
