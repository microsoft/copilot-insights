# Local validation: October 2–3, 2026

## Result

**The Docker Compose deployment, synthetic integration checks, and one native Windows Local Copilot emission/capture/restore test work locally, including the analytics/human review portal. Shared, authenticated team analytics and the Intune-managed production client remain unimplemented.**

Reviewed the [quick start](../README.md), [participant guide](client-setup.md), [infrastructure guide](infrastructure.md), [architecture](architecture.md), [data contract](data-contract.md), and [rollout status](rollout-plan.md). M3 was initially not started; the local review prototype was added afterward as described in the [analytics guide](analytics.md). The native fallback and initial two-container Docker evidence below are retained as validation history.

The first validation used a native Windows fallback because Docker was not installed. Docker Desktop was then installed per-user with the WSL2 Linux backend, after verifying the installer's Docker Inc. signature and SHA-256. No reboot was required. The native services were stopped, and the unchanged [Compose deployment](../deploy/local/compose.yaml) was built and started successfully. The Docker rerun verifies the Linux collector image, Compose networking, and Windows bind-mount write permissions as well as the shared pipeline.

No Azure resources were deployed **during this local run**; the later [infrastructure-only Azure validation](azure-validation.md) is separate and does not qualify cloud ingestion. The earlier synthetic runs did not change normal VS Code settings. The native exercise below temporarily changed them with explicit permission and restored them byte for byte afterward. Only a harmless disposable task was used, not private repositories or real-work conversations.

### Local analytics update

The new [review application](../apps/insights/) runs at `http://127.0.0.1:3000`, alongside Aspire diagnostics. Its Docker container runs as a non-root user, with a read-only root filesystem and telemetry mount, loopback-only publication, and a separate writable review volume. Its frontend, icons, and fictional examples are original; no private source, assets, datasets, or service dependencies were copied into this project.

All 23 analytics/API regression tests pass. A further collector verification, run `06ac8f97d8a948fcbcb47f229c7b9817`, passed all 26 checks. The live analytics API then increased by exactly one agent run, one model call, one tool execution, 1,380 tokens, and one intentional model error, without leaking canaries. At that point the collector source contained four model calls and 5,520 observed tokens; the independent demo source was kept separate.

The human review UI displays aggregate activity, model/tool breakdowns, coverage and freshness, rule explanations, and sanitized evidence. Decisions use fixed states rather than free-text notes or identities and are bound to a source/window/evidence fingerprint. This local implementation is not a production cloud query service or a pilot/privacy approval.

### Signal compatibility and provenance update

The fixture was checked against the public VS Code monitoring guide on October 2, 2026: four documented span operations, two counters, two histograms, and two event names matched. See the [contract comparison and source snapshot](data-contract.md#signal-compatibility-and-fixture-provenance). The deliberately unsupported metric remains a negative control, not a purported native event.

All 12 offline fixture-contract tests and the eight telemetry-reader tests passed. The updated live verifier, run `0e5e31cf75f5497da24d14b89d0a60ea`, passed all 31 checks, including histogram units/types and the published feedback correlation field. An ordinary PowerShell `Write-Output` control produced no additional Copilot spans.

With **Local collector / 7 days** selected, the portal/API baseline contained four agent runs, four model calls, four tool executions, and 5,520 observed tokens. After direct fixture injection, those became five runs/calls/tool executions and 6,900 tokens, with exactly one additional intentional model error. Parent token totals and the new metric observations did not inflate the span-derived result; no test canaries appeared in the API.

No VS Code/Copilot agent action was executed to create these fixtures, and no normal editor settings were changed during that phase. Those results remain **synthetic integration validation**, distinct from the later native-client exercise. The README separates deployment, baseline observation, dummy injection, a second observation, and an opt-in real Local Copilot task with restoration.

### Native client emission and restoration

On **October 3, 2026 at 02:01 UTC** (**October 2, 2026 at 7:01 PM PDT**), the native desktop **VS Code 1.140.0**, with bundled **GitHub.copilot-chat 0.68.0**, ran a Local Agent chat in a disposable folder outside the repository. This was the editor's Copilot process, not the fixture script, terminal CLI, an Agent Host session, or a substitute SDK emitter.

The tested sequence was:

1. Confirm the deployed collector/portal and record the **Local collector / 7 days** baseline. No synthetic verification command ran during the native comparison.
2. Run `setup-client.ps1 Install -Local -Temporary` with a non-personal validation label. The script preserved an existing enabled OTel preference, replaced routing temporarily with the local OTLP/HTTP collector, and kept content/identity capture off. Only the disposable editor window was reloaded.
3. Submit a native Local Copilot request to read `hello.txt` with a file tool and run `Write-Output 'copilot-insights-native-check'` with the terminal tool, without modifying files or using network tools. The native UI reported completion in 21 seconds and showed the expected terminal output. Mark that sample response **Helpful** to exercise a native feedback event.
4. Read only the native run's sanitized collector records. Verify `service.name=copilot-chat`, scope `copilot-chat`, and **native** `service.version=0.68.0`, distinct from `0.0.0-verification` fixtures; correlate the file/terminal spans to the agent trace and feedback to its conversation.
5. Refresh the portal, compare it with the baseline, and reconcile observed-token deltas against native model spans only.
6. Run [restore-client.ps1](../scripts/restore-client.ps1) through the verification runner's `finally` path. The pre/post settings SHA-256 matched, the private snapshot was removed, and only the disposable window was closed. Its temporary folder trust was also removed. Existing unrelated sessions were not restarted or stopped.

| Signal | Captured native evidence |
|---|---|
| Traces | One correlated seven-span task: `invoke_agent`, three `chat` calls, and `execute_tool` spans for `manage_todo_list`, `read_file`, and `run_in_terminal` |
| Duration/token histograms | `gen_ai.client.operation.duration`, `gen_ai.client.token.usage` |
| Additional histograms | `copilot_chat.agent.invocation.duration`, `copilot_chat.agent.turn.count`, `copilot_chat.time_to_first_token`, `copilot_chat.tool.call.duration` |
| Counters | `copilot_chat.session.count`, `copilot_chat.tool.call.count`, `copilot_chat.user.feedback.count` |
| Event / OTLP log | `copilot_chat.user.feedback`, with `conversation_id` matching the agent conversation; this log did not have a trace ID |

These are documented signal types in [What gets collected](https://code.visualstudio.com/docs/agents/guides/monitoring-agents#_what-gets-collected). The collector deliberately retains only the project's [approved subset](data-contract.md#signal-compatibility-and-fixture-provenance), not every event emitted by the client.

All nine families matched their expected histogram/counter kinds, and the counters were monotonic cumulative OTLP Sums. **The native captured metrics omitted the OTLP `unit` field.** The documented units describe intended semantics, but unit metadata was not verified on the wire for this client. The synthetic fixtures do carry explicit units; their checks must not be presented as native unit coverage. Portal tokens and latency come from spans, so the missing metric-unit metadata did not affect this comparison. Track it in broader client/backend qualification rather than silently fabricating native fields.

| Portal measure | Before | After | Native delta |
|---|---:|---:|---:|
| Agent runs | 5 | 6 | +1 |
| Model calls | 5 | 15 | +10 |
| Tool executions | 5 | 11 | +6 |
| Observed model tokens | 6,900 | 119,925 | +113,025 |
| Explicitly reported model errors | 5 | 5 | 0 |
| Unknown model outcomes | 0 | 10 | +10 |
| Review signals | 1 | 3 | +2 |

The native extension also emitted seven auxiliary model calls and three additional tool spans outside the main task trace. The portal counts eligible native model/tool spans, not just the main task's children. Its delta exactly matched the ten model spans' 113,025 tokens: 103,984 in the main task plus 9,041 in auxiliary calls. Parent-agent totals and metric samples were not added again. Native calls without explicit outcome attributes stayed **unknown**, not silently successful. The portal added latency and outcome-coverage review signals; the five deliberate fixture errors remained visibly part of the mixed local dataset.

The sample command/output marker, sample filename, and checked content/identity attribute keys were absent from the sanitized capture. Original settings and raw diagnostic exports were not added to source control; runtime evidence stays in the ignored local data directory. No internal project source, assets, or datasets were copied. These checks do not close the known array/link/exemplar privacy gaps or authorize collection of real-user workloads.

The settings suite now passes **22 tests**, including existing preferences, BOM/CRLF/comments, missing files, environment restrictions, opt-out, `-WhatIf`, double install, concurrent edits, snapshot integrity, interrupted installation, and exact restoration. The original `otel.enabled=true` value was restored too: reversal restores the prior configuration, not a blanket telemetry disable.

## Environment and evidence

- Windows x64; PowerShell 7.6.6; WSL 2.7.13.
- Docker Desktop 4.93.0 (240920), Engine/CLI 29.8.1, Compose v5.5.1; `desktop-linux` context.
- OpenTelemetry Collector Contrib 0.161.0 in the repository-built Linux image, using the existing [base](../collector/config/base.yaml) and [local](../collector/config/local.yaml) profiles without configuration changes.
- Aspire dashboard 13.6.0, using the digest-pinned image in [compose.yaml](../deploy/local/compose.yaml).
- Collector runs as `10001:10001` and successfully writes to the Windows bind-mounted output directory.
- Published host ports: collector HTTP ingestion on `127.0.0.1:4318`, health on `127.0.0.1:13133`, and dashboard UI on `127.0.0.1:18888`. Docker port bindings and Windows listener addresses were checked. Dashboard OTLP receiver ports are not published to the host.

| Check | Observed result |
|---|---|
| Compose configuration, image build, and startup | Passed with the checked-in configuration; both containers running with zero restarts |
| Collector configuration validation | Passed |
| Client setup tests | All 11 passed using temporary settings files |
| Telemetry file-reader regression tests | All 8 passed |
| Expanded live verification | All 26 checks passed in each of three consecutive Docker-backed runs |
| Sanitized storage | Traces, metrics, and logs reached `deploy/local/.data/telemetry.jsonl` |
| Canary and collector-log scan | No `CANARY-` marker in the collected verification output or container logs; no error-level collector log entries |
| Dashboard trace view | Three fresh Docker-backed traces; each has parent agent and child model/tool spans, timing, and an intentional model error |
| Dashboard span attributes | `example-model`, 1,200 input tokens, and 180 output tokens displayed |
| Dashboard metrics | Tool-call and feedback instruments present; tool-call table showed value 3 with `readFile` and `success=true` dimensions |
| Dashboard structured logs | Three trace-linked feedback records present; message bodies empty as required |

The three Docker verification run IDs were `c4d2bfc2ce2c42d693243caeb3d46ebb`, `e9b8528618da4597aa5d02a5e2ba4822`, and `334448cf62904c21949d3b1f66876228`. The last run's trace, `7751189e716a21e7d1242922d18ca58d`, was inspected in the browser, including its model token attributes, one-second model duration, and preserved `example_error` classification. Traces, metrics, and structured-log views were all checked against the Docker-backed dashboard.

The earlier native fallback also passed three consecutive expanded runs: `66afeff5845e46dc9edf9ef681f59402`, `8f04449f87eb4379a81dcdc3218a831c`, and `bdd5d95920b944b9a0560effd00ff998`. Repeated verification adds separate synthetic traces; it is not real usage.

### Verification bug fixed

The first live run returned HTTP 200 for all signals but failed with an unterminated JSON string while reading the collector output. The collector was still writing the final JSONL record; the same record parsed successfully after the write completed.

[read-telemetry.ps1](../scripts/read-telemetry.ps1) now reads a snapshot and only parses newline-terminated records. Incomplete final records are retried by [verify.ps1](../scripts/verify.ps1); malformed complete records still fail. The regression suite covers missing/empty output, run filtering, split writes while the writer remains open, CRLF/BOM input, and corrupt complete records. CI runs that suite as well.

Verification also now checks output tokens, derived model latency, preserved error classification, and trace-parent correlation, because these are prerequisites for meaningful analytics.

## Can insights be composed?

**The local collector-file adapter now composes aggregate views and deterministic findings.** The original one-trace calculation below is also the analytics test fixture; there is still no authorized cloud query adapter:

| Measure | Result |
|---|---|
| Top-level agent invocations | 1 |
| Model calls | 1 |
| Executed tools, from spans | 1 |
| Model | `example-model` |
| Input / output / total model tokens | 1,200 / 180 / 1,380 |
| Agent / model / tool duration | 4,000 / 1,000 / 100 ms |
| Explicitly errored model calls | 1 |
| Parent-child correlation | Preserved |

These are fixture expectations, not production analytics results. Tokens were taken from the model span only, not added to parent-agent totals. The independent cumulative tool-counter fixture has value 3; it must not be added to the tool-span count or summed across repeated samples. No cost or productivity inference was made.

Still needed for shared deployment: an authorized cloud store/query adapter, production cross-runtime counting and replay guarantees, cumulative/delta metric handling, retention and access policy, and an audited shared workflow. The local adapter has bounded-file replay handling and golden-fixture tests, but does not qualify those production requirements. See the [counting contract](data-contract.md#counting-and-correlation).

## Is the UX site there?

**Yes for local analytics and human review, as well as diagnostics.** The new [review site](analytics.md) is available on loopback port 3000. The separate Aspire site still has structured logs, trace waterfalls with attributes, and per-instrument metric graphs/tables at `http://127.0.0.1:18888`.

The project-owned frontend and local API now provide usage/tokens/latency/errors, model/tool breakdowns, source/time filters, visible unknown/stale states, and local review decisions. An Azure analytics deployment, authorized cohort filters, and shared authentication are still absent. Server-side authorization is required before any shared deployment; hiding or filtering rows in the browser is not sufficient.

The Aspire diagnostic dashboard is anonymous and has no persistent volume. It is not a team service or durable analytics store. Direct navigation to `/traces`, `/metrics`, and `/structuredlogs` works; automated sidebar clicks were intermittently intercepted by the dashboard's responsive navigation overlay in the embedded browser, so this is not a complete navigation/accessibility qualification. The new review site's separate volume persists decisions only, not raw telemetry or a shared audit history.

### Review workspace browser checks

- All four views rendered at 390 and 1,440 CSS pixels without page overflow. Source/time selectors, queue search and status filters, evidence drawers, and local Aspire trace links were exercised.
- Escape closed both the evidence and privacy dialogs, returning keyboard focus to the triggering control.
- A synthetic investigation decision survived page reload and Docker container recreation through the dedicated review volume. The test decision was reset to unreviewed afterward; no synthetic approval was left in the workspace.
- Switching from the synthetic source to the collector returned the four local fixture runs rather than mixing their datasets. Observed page resources were served solely from `http://127.0.0.1:3000`.
- After the final rebuild, the analytics health endpoint, collector health endpoint, and Aspire traces page returned HTTP 200. The analytics container was healthy, ran as the non-root `node` user, and retained its read-only root filesystem and telemetry mount, dropped capabilities, and no-new-privileges restriction.

These are local functional checks, not a complete accessibility audit or a qualification for authenticated, shared deployment.

Compose configuration and whitespace checks passed. An optional standalone YAML parser check for the workflow and Compose file could not run because npm registry requests failed with TLS handshake errors, including a retry from the host. No TLS verification was disabled and no project dependencies were added.

## Reproduce the Docker deployment

Run from the repository root in PowerShell 7.2+ with Docker Desktop's Linux backend. If a terminal opened before installation does not recognize `docker`, reopen it to pick up the installer's PATH changes. Do not run the native fallback at the same time: both deployments use the same host ingestion, health, and dashboard ports.

```powershell
docker desktop start --timeout 180
docker compose -f deploy/local/compose.yaml config --quiet
docker compose --progress plain -f deploy/local/compose.yaml up --build --detach
./scripts/verify.ps1 -TimeoutSeconds 60
docker compose -f deploy/local/compose.yaml ps
```

Open the analytics/review site at `http://127.0.0.1:3000`. For raw diagnostics, open `http://127.0.0.1:18888/traces`, `/metrics`, or `/structuredlogs`. In Aspire Metrics, choose `copilot-chat` and the tool-call instrument; widen the default five-minute window if the sample is no longer visible. Send telemetry to the collector on port 4318, not directly to either site, so it passes through the privacy pipeline.

The Docker stack was left running for inspection. To stop and remove its containers:

```powershell
docker compose -f deploy/local/compose.yaml down
```

This leaves the generated telemetry file and downloaded tools intact. Compose uses `restart: unless-stopped`, so existing containers can restart when the Docker engine starts; no real-client export or client-forwarder startup was enabled.

## Reproduce the native Windows fallback

The [Docker quick start](../README.md#try-it-on-your-machine) is now verified on this machine and remains the documented cross-platform route. The following historical fallback was used before Docker installation. Stop the Compose stack before using it. Run commands from the repository root in PowerShell 7.2+ on Windows x64. It requires outbound access to the public GitHub release artifacts and the Windows `tar` command, but does not require Docker or Azure sign-in.

### 1. Acquire the pinned tools

Skip this step if this validation session's tools are still present. Stop running tools before extracting over an existing copy. The downloads, extracted binaries, dashboard state, and telemetry remain under the Git-ignored `deploy/local/.data` directory.

```powershell
$ErrorActionPreference = 'Stop'
$tools = Join-Path $PWD 'deploy/local/.data/tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null
$collectorArchive = Join-Path $tools 'otelcol-contrib_0.161.0_windows_amd64.tar.gz'
Invoke-WebRequest -Uri 'https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.161.0/otelcol-contrib_0.161.0_windows_amd64.tar.gz' -OutFile $collectorArchive
if ((Get-FileHash -LiteralPath $collectorArchive -Algorithm SHA256).Hash -ne 'fd1a6d23aa7855efc4fc12e4ee2c21b410e0a35c85587a07def7746eec9cea24') { throw 'Collector checksum mismatch' }
tar -xzf $collectorArchive -C $tools otelcol-contrib.exe
if ($LASTEXITCODE -ne 0) { throw 'Collector extraction failed' }

$aspireTools = Join-Path $tools 'aspire'
New-Item -ItemType Directory -Path $aspireTools -Force | Out-Null
$aspireArchive = Join-Path $aspireTools 'aspire-cli-win-x64-13.6.0.zip'
Invoke-WebRequest -Uri 'https://github.com/microsoft/aspire/releases/download/v13.6.0/aspire-cli-win-x64-13.6.0.zip' -OutFile $aspireArchive
if ((Get-FileHash -LiteralPath $aspireArchive -Algorithm SHA512).Hash -ne 'f4597e83d215a1ed4096cadfd496bbcf62aeb38cfb297ceb9275d3f5ff13e7a8c9d0c0a864e9f803a6a95581b7b3c0dfd2be1dfa8de297542e39bcb0f7e71807') { throw 'Aspire checksum mismatch' }
Expand-Archive -LiteralPath $aspireArchive -DestinationPath $aspireTools -Force
```

### 2. Start the dashboard in one terminal

Keep this terminal running. Using a workspace-local `ASPIRE_HOME` avoided a bundle-directory promotion failure encountered with the default user-profile location on this machine.

```powershell
$env:ASPIRE_HOME = Join-Path $PWD 'deploy/local/.data/aspire-home'
$env:ASPIRE_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
& ./deploy/local/.data/tools/aspire/aspire.exe dashboard run --frontend-url http://127.0.0.1:18888 --otlp-grpc-url http://127.0.0.1:18889 --otlp-http-url http://127.0.0.1:18890 --allow-anonymous --persistence None --non-interactive --nologo
```

### 3. Start the collector in another terminal

Keep this terminal running as well. Send telemetry to port 4318, not directly to the dashboard receivers, so it passes through the privacy pipeline.

```powershell
$env:CI_ORGANIZATION_ID = 'local-dev'
$env:CI_OTLP_HTTP_ENDPOINT = '127.0.0.1:4318'
$env:CI_HEALTH_ENDPOINT = '127.0.0.1:13133'
$env:CI_LOCAL_OUTPUT_PATH = Join-Path $PWD 'deploy/local/.data/telemetry.jsonl'
$env:CI_DASHBOARD_OTLP_ENDPOINT = '127.0.0.1:18889'
$env:GOMEMLIMIT = '128MiB'
& ./deploy/local/.data/tools/otelcol-contrib.exe validate --config=collector/config/base.yaml --config=collector/config/local.yaml
if ($LASTEXITCODE -ne 0) { throw 'Collector configuration is invalid' }
& ./deploy/local/.data/tools/otelcol-contrib.exe --config=collector/config/base.yaml --config=collector/config/local.yaml
```

### 4. Verify and inspect

In a third terminal:

```powershell
./scripts/tests/setup-client.tests.ps1
./scripts/tests/telemetry.tests.ps1
./scripts/verify.ps1 -Endpoint http://127.0.0.1:4318 -HealthEndpoint http://127.0.0.1:13133/ -TimeoutSeconds 60
```

Open `http://127.0.0.1:18888/traces`, select a trace, and inspect its `chat` span. In Metrics, select `copilot-chat` and the tool-call or feedback instrument, then switch between Graph and Table. The metrics view defaults to the last five minutes; rerun verification or widen the time window if the sample is no longer visible.

### 5. Stop

Press Ctrl+C in both service terminals. For processes left running by a validation tool, the following stops only the matching executables beneath this repository's local data directory:

```powershell
$dataRoot = [IO.Path]::GetFullPath((Join-Path $PWD 'deploy/local/.data')) + [IO.Path]::DirectorySeparatorChar
Get-Process -Name otelcol-contrib,Aspire.Dashboard,aspire -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($dataRoot, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process
```

There is no automatic startup configured for the native fallback. Stopping its services does not remove the generated output or tool archives.

## Not qualified by this run

- Other VS Code/Copilot versions, Agent Host, terminal CLI, remote-host telemetry, and full native signal coverage beyond the tested Local sample.
- Azure authentication, deployment, durable ingestion, and stored-data queries.
- Complete privacy coverage: [documented gaps](architecture.md#processing-pipeline) for span links, metric exemplars, and array-valued attributes remain.
- A production analytics service or shared, authenticated analytics UX.
- Intune package installation, managed startup/remediation, production client authentication, and fleet rollback.

Passing synthetic checks and one harmless native local exercise is not approval to collect real-user telemetry or invite a team pilot. The organization rollout must follow the [Intune plan and release gates](intune-deployment.md).
