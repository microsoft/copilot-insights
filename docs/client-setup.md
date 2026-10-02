# Client setup

This guide is for people taking part in a Copilot Insights pilot. One script connects VS Code on your machine to your organization's collector, tells you whether it works, and removes everything again when you are done.

## What changes on your machine

- **One block in your VS Code user settings.** It turns on Copilot's OpenTelemetry export, keeps content and identity capture off, and points the export at `127.0.0.1`. The block sits between `copilot-insights` marker comments. Nothing else in the file changes, and the script keeps a backup of the file until you uninstall.
- **A forwarder process that runs as you.** The forwarder is the open-source [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/), pinned to one version and checksum-verified, installed under `%LOCALAPPDATA%\CopilotInsights`. It listens only on `127.0.0.1`. It removes everything outside the [data contract](data-contract.md) before data leaves your machine, then forwards the rest to your organization's collector with a token from your Azure CLI sign-in.

You do not need administrator rights, and nothing is installed system-wide.

### Why a forwarder

Copilot sends telemetry to an endpoint but does not authenticate itself to it. A token placed in VS Code settings or environment variables would expire within about an hour, and other tools, including agent tool processes, could read it. The forwarder renews tokens through Azure CLI and keeps them out of VS Code entirely. Because it also filters, your organization's collector never receives the fields the data contract excludes.

## What is sent

Operation types (agent run, model call, tool call), model and tool names, token counts, durations, error categories, feedback ratings, edit accept or reject outcomes, and the cohort label you choose. Names that look like free text, paths, URLs, or email addresses are replaced with `redacted`.

Not sent: prompts, responses, code, file paths, repository or branch names, your account name, or your machine name. The [data contract](data-contract.md) has the complete lists.

## Before you start

- Windows with [PowerShell 7.2 or later](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) (`pwsh`).
- VS Code with GitHub Copilot, with VS Code telemetry not turned off (`telemetry.telemetryLevel` is not `off`). Copilot exports nothing while it is off, and the script does not change that setting.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows), signed in with your work account: `az login`.
- A copy of this repository.
- From your administrator: the collector **endpoint**, the ingestion **scope**, and confirmation that you have been **assigned** to the pilot. Assignment means the administrator added you to the sign-in application that issues ingestion tokens; without it, Install stops with error `AADSTS50105`.
- A network path to the collector, which has only a private address. Your administrator can tell you whether your machine qualifies; Dev Boxes on the pilot's network do.

## Install

From the repository root, in PowerShell 7:

```powershell
./scripts/setup-client.ps1 Install -Endpoint <endpoint> -Scope <scope> -Cohort <team-name>
```

`-Cohort` is optional. It labels your telemetry with a group, such as your team, so results can be compared between groups. Use a short label such as `team-a`, never a personal name. Add `-WhatIf` to preview the changes without making them.

The script checks that Azure CLI can get a token, downloads and verifies the collector, adds the settings block, and starts the forwarder:

```text
Setting up Copilot Insights (forwarder)
  Azure CLI can get an ingestion token.
  Installed OpenTelemetry Collector 0.161.0 (checksum verified).
  Added the settings block to C:\Users\<you>\AppData\Roaming\Code\User\settings.json.
  Forwarder running on 127.0.0.1:4319.
```

Then reload every VS Code window (Command Palette: **Developer: Reload Window**). Copilot reads these settings only when a window starts.

> [!IMPORTANT]
> The forwarder does not start automatically after you restart or sign in to Windows again; automatic start is not implemented yet. Run `./scripts/setup-client.ps1 Start` each time. Until you do, Copilot works normally but sends nothing.

## Check that it works

```powershell
./scripts/setup-client.ps1 Status
```

When everything is in place, Status ends with `Ready`:

```text
Copilot Insights client status
  Mode:                forwarder on 127.0.0.1:4319 -> https://<endpoint>
  VS Code settings:    block present in C:\Users\<you>\AppData\Roaming\Code\User\settings.json (endpoint http://127.0.0.1:4319)
  VS Code telemetry:   on
  Env overrides:       none
  Policy values:       none found
  Forwarder:           running (process 12345)
  Ingestion token:     available from Azure CLI
  Recent forwarder:    no warnings or errors

Ready. Telemetry from reloaded VS Code windows can flow.
```

Otherwise it lists what needs attention and exits with code 1.

## Day to day

- **After a restart or a new Windows sign-in**, run `./scripts/setup-client.ps1 Start`.
- **To pause**, run `Stop`. Copilot keeps working normally, and nothing leaves your machine until you run `Start` again.
- **If the forwarder is not running**, Copilot is not affected; its telemetry export simply fails in the background.

## Remove

```powershell
./scripts/setup-client.ps1 Uninstall
```

This stops the forwarder, removes the settings block, and deletes `%LOCALAPPDATA%\CopilotInsights`. Reload VS Code windows afterwards.

## Troubleshooting

| Message or symptom | What to do |
|---|---|
| `Azure CLI could not get a token ... AADSTS50105` | You are not assigned to the ingestion app. Ask your administrator to add you. |
| `Azure CLI could not get a token ... AADSTS65001` | Azure CLI is not authorized for the ingestion app. Your administrator needs to pre-authorize it (see [Infrastructure](infrastructure.md#register-the-ingestion-api)). |
| `Azure CLI could not get a token ... az login` | Your Azure CLI session expired. Run `az login`. |
| `Your VS Code settings already configure Copilot OpenTelemetry` | You already have `github.copilot.chat.otel.*` settings of your own. Remove them, or keep your configuration and skip the pilot. |
| `VS Code telemetry is turned off` | `telemetry.telemetryLevel` is `off`, and Copilot exports nothing while it is off. Copilot Insights respects that choice and does not change it. |
| Status lists **Env overrides** | Variables such as `OTEL_EXPORTER_OTLP_ENDPOINT` or `COPILOT_OTEL_*` take precedence over settings and can send telemetry elsewhere. Remove them from your user environment, then restart VS Code. |
| Status lists **Policy values** | Your organization manages VS Code or Copilot telemetry through policy, which wins over personal settings. Ask your administrator. |
| Status shows **Forwarder: not running** | Run `./scripts/setup-client.ps1 Start`. If it fails, the error names the log file. |
| Forwarder log shows `401` | The collector rejected the token. Check with your administrator that the scope is right and you are assigned to the app. |
| Forwarder log shows connection or DNS errors | Your machine cannot reach the collector. The endpoint must resolve to a private address from a connected network. |
| `The forwarder did not start within 90 seconds` | Another program may be using port 4319 or 13134. The log file named in the message has the details. |

## Questions

**Does this slow Copilot down?** Copilot exports telemetry in the background, and the forwarder is limited to 256 MiB of memory. Neither sits between Copilot and its model service.

**Can I see what is sent?** Yes. The forwarder applies the same pipeline as the [local quick start](../README.md#try-it-on-your-machine). Running `Install -Local` with the quick start shows the filtered telemetry in a local dashboard.

**Does it work on macOS or Linux?** `Install -Local` works on any platform with PowerShell 7. The forwarder currently supports Windows only.
