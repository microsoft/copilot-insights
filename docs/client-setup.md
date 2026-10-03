# Client setup

**Organization deployment is administrator-managed through Microsoft Intune.** Employees do not clone this repository, run setup or startup scripts, choose telemetry endpoints, or handle tokens. Endpoint administrators own assignment, configuration, updates, health, and removal under the [Intune production plan](intune-deployment.md).

**Current status:** that plan is not yet a released Intune package. One native Windows Local Copilot test has passed [local verification](local-validation.md#native-client-emission-and-restoration); production authentication, managed startup, privacy qualification, Azure delivery, and shared analytics remain release gates. Do not enroll real-user workloads until they pass.

Just exploring? Use the [local demo](../README.md#try-it-on-your-machine), which needs no Azure setup. Its optional native-client exercise uses a disposable project, not an organization rollout.

## Managed onboarding

1. Your administrator confirms that the Windows device is enrolled in Intune and assigned to the approved deployment ring. They supply a collection notice, approved network requirements, and a support contact.
2. Intune installs the qualified client package and applies the approved Copilot managed telemetry policy. The forwarder filters metadata on the device before authenticating uploads to the private collector.
3. Save your work and reload the designated VS Code window when the rollout notice or editor requests it. Use only the qualified runtime; Local, Agent Host, terminal CLI, and remote windows do not have interchangeable telemetry paths.
4. If support requests a validation task, use a harmless disposable sample. Support verifies native provenance and stored-data delivery; an enabled setting or healthy process alone does not prove success.

You should not need Docker, Azure CLI, repository files, collector configuration, or a daily startup command for this managed flow. The production package must implement its approved enrollment and token lifecycle before deployment; do not paste a token into settings or a support message.

## Day to day

- Use Copilot normally within the approved collection scope. Inference requests and model selection are separate from the telemetry forwarder.
- Updates, startup after sign-in/reboot, and safe health remediation are managed centrally. A telemetry failure must not block development.
- Request a pause, opt-out, or removal through the support process in your collection notice. Administrators change Intune assignments/policy and remove only deployment-owned components.
- Existing disabled telemetry and applicable policy restrictions must be respected. Do not delete settings, remove policy, or change environment variables to bypass them.
- Removing the client does not remove already-collected records. Ask the service owner about retention and deletion.

## What is collected

The intended data is usage metadata: operation/tool names, models, token counts, timings, error categories, supported feedback, and approved group labels. Content and identity capture remain off in the planned baseline. The filters exclude known content, identity, repository, and path fields, but still have [validation gaps](architecture.md#processing-pipeline). This preview is not a universal sensitive-data filter or an individual productivity score.

The [local portal](analytics.md) composes span-based aggregates and human-review signals. Its review decisions are not Copilot thumbs-up/down events. Authenticated shared analytics and an Azure query adapter are separate, unimplemented production work.

## Local development and administrator diagnostics

Manual scripts are for **opt-in local tests or controlled administrator diagnostics only**, not employee onboarding. Run them from the repository using PowerShell 7.2+.

For a short local test, deploy first and follow the [full baseline/action/observe walkthrough](../README.md#optional-connect-vs-code):

```powershell
./scripts/setup-client.ps1 Install -Local -Temporary
./scripts/setup-client.ps1 Status
```

After observing the native task, restore settings **even if the test fails**, then close or reload the test window:

```powershell
./scripts/restore-client.ps1
```

Temporary setup can replace existing user OTel preferences, but never a managed Copilot Insights installation, disabled VS Code telemetry, or conflicting policy/routing overrides. It temporarily serializes the settings object and removes existing exporter-specific preferences, including headers. It saves the original bytes in a sensitive full-settings snapshot outside the repository, under `%LOCALAPPDATA%\CopilotInsights` by default. Restoration preserves the original comments, formatting, encoding, and values byte for byte, then deletes the snapshot.

Do not edit user settings during the test. Restore checks the file hash and refuses to overwrite concurrent edits; retain the local snapshot, save/reconcile those edits locally, then retry and reapply them after restoration. Never publish the snapshot. `-SettingsPath` and `-InstallRoot` support a designated test profile; keep the install root outside source control. Both scripts support `-WhatIf`.

The non-temporary diagnostic setup still supports `Install`, `Start`, `Stop`, `Status`, and `Uninstall`. Its remote mode requires the administrator's approved endpoint/scope and an existing Azure CLI sign-in, and still needs manual startup. Use `setup-client.ps1 Uninstall` to remove that ordinary marked-block installation; `restore-client.ps1` is specifically for `Install -Local -Temporary`. Neither is an implemented Intune installer or fleet removal path.

## Troubleshooting

| Symptom | Next step |
|---|---|
| Managed package is missing or unhealthy | Contact endpoint support with device deployment status; administrators check Intune detection/remediation, not an employee-run setup command |
| Authentication or HTTP `401` errors | Send the error code to support; identity owners verify enrollment, token lifecycle, issuer/audience and authorization |
| VS Code telemetry is off, or policy/environment conflicts are reported | Leave restrictions in place; support checks effective values using Developer: Policy Diagnostics |
| Connection or DNS errors | Use the approved network; service owners check private connectivity and DNS |
| Local test has no new portal activity | Select My VS Code organization, refresh, and check the test window's Local harness/reload, native service version, and collector health; Demo organization never receives editor activity, and fixture success is not native proof |
| Restore reports concurrent settings edits | Keep the private snapshot and reconcile edits locally; there is deliberately no force-overwrite option |

Share reviewed error codes and non-sensitive status only, not access tokens, settings backups, raw telemetry, or full diagnostic logs.
