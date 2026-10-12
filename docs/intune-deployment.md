# Organization deployment with Microsoft Intune

**Microsoft Intune is the planned organization production deployment path.** Administrators assign and maintain the client through managed device groups. Employees do not clone this repository, run setup/start/restore scripts, configure endpoints, or handle telemetry credentials.

**Plan, not a shipped deployment package.** The repository provides a local collector, a Windows diagnostic forwarder, local setup/restore scripts, and an Azure reference template. It does not yet provide an Intune package, managed startup/remediation, or a production credential lifecycle. The [native local validation](local-validation.md#native-client-emission-and-restoration) proves one Local Copilot runtime on one machine, not fleet or Azure readiness. Complete the gates below before assigning a production group.

## Ownership and rollout

| Owner | Responsibility |
|---|---|
| Endpoint management | Intune enrollment, signed client packaging, managed configuration, required group assignments, upgrades, detection/remediation, and uninstall |
| Identity and service engineering | Supported client identity/token lifecycle, authorized private ingestion, storage verification, and revocation |
| Security/privacy | Collection notice, permitted fields, opt-out handling, access, retention, and incident/deletion policy |
| Operations/support | Client health and delivery monitoring, staged promotion, support contact, and rollback drills |

Use separate **lab**, **approved pilot**, and **broad rollout** assignment groups, with explicit exclusions and a versioned configuration manifest. Promote only after the previous ring passes the [acceptance criteria](rollout-plan.md#acceptance-criteria). Organization-specific hosts, identifiers, assignments, policies, and evidence remain outside the public repository.

## Managed configuration

Use Intune-managed delivery of the documented [Copilot native MDM settings](https://code.visualstudio.com/docs/enterprise/manage-ai-settings#_deliver-managed-settings-through-native-mdm). On Windows their policy location is `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\GitHubCopilot`, **not** the ordinary VS Code user-settings file or `Microsoft\VSCode` policy key. Scalar managed keys use dot-separated names; structured values use JSON strings. Validate registry types and the registry view against the pinned client's schema in the lab. Do not assume every key has a built-in Intune Settings Catalog entry.

The planned baseline uses the [managed telemetry keys](https://code.visualstudio.com/docs/enterprise/manage-ai-settings#_configure-telemetry-export-with-opentelemetry):

| Managed key | Planned value / constraint |
|---|---|
| `telemetry.enabled` | `true` only for approved, enrolled devices after the local forwarder is ready |
| `telemetry.endpoint` | `http://127.0.0.1:4319`, the on-device filtering/authentication forwarder; never the unauthenticated demo collector in production |
| `telemetry.protocol` | `http/json`, qualified against the selected Local client and forwarder |
| `telemetry.captureContent` | `false` |
| `telemetry.lockCaptureContent` | `true` |
| `telemetry.capture.identity` | `false` |
| `telemetry.resourceAttributes` | Approved non-personal configuration version, rollout ring, and cohort labels |
| `telemetry.headers` | No bearer tokens, client secrets, or other credentials |
| `telemetry.serviceName` | Leave native runtime identity unchanged; do not relabel Agent Host or CLI traffic as `copilot-chat` |

The telemetry block is selected **as a whole** from the highest-priority managed channel, not merged field by field with lower-priority blocks. Deliver the full approved baseline and avoid competing ownership across native MDM, server-managed policy, and file-based policy. Copilot Chat environment overrides still affect several fields; detect conflicts centrally and resolve their ownership rather than silently bypassing them. Preserve disabled VS Code telemetry and applicable organizational restrictions.

Verify effective values and their sources with **Developer: Policy Diagnostics**, then verify actual export from a harmless Local Copilot task. Plan the required editor reload with users; do not forcibly restart editors with unsaved work. Managed policy behavior and reload requirements are described in the [VS Code enterprise guide](https://code.visualstudio.com/docs/enterprise/manage-ai-settings#_configure-telemetry-export-with-opentelemetry).

## Client package and lifecycle

The managed package must also include the signed [project companion](../extensions/project-context). Endpoint administrators configure its machine-scoped service origin, `authentication=entra`, tenant ID, public-client ID, and API audience. Identity administrators assign the API's non-admin `Insights.Publisher` role and consent to `Context.Publish`; reserve `Insights.Admin` and `Insights.Read` for report reviewers. These are Entra app roles, not Azure subscription RBAC.

Users choose their current project in the companion's status bar, or another approved tool writes the [project file](projects.md#set-the-project-from-another-tool). The companion registers only the project ID and native window ID; it does not ship project catalogs, workspace paths, or credentials. Selecting a project does not grant access to analytics. Validate separate windows, multiple chats, unattributed activity, reload boundaries, and token refresh in each managed pilot ring. This companion is implemented as source; signed Intune packaging and live tenant qualification are still release gates. See [production access and role validation](production-access.md).

Build a signed, versioned installer and package it as an Intune Win32 app using the [Win32 Content Prep Tool](https://learn.microsoft.com/intune/app-management/deployment/create-win32-package). Follow [Intune's Win32 deployment workflow](https://learn.microsoft.com/intune/app-management/deployment/add-win32) for requirements, silent install/uninstall commands, detection rules, dependencies, assignments, and supersedence.

- Include the pinned, checksum-verified collector, the reviewed filtering configuration, lifecycle components, and a manifest. Do not download an unpinned executable during installation.
- Decide installer and runtime identity separately. A device-context installer may provision protected files and policy, but the runtime must use the identity approved for authentication. Installing as `SYSTEM` does not provide a user's Azure CLI cache or sign-in.
- Implement automatic startup, restart after failure, bounded retry/offline behavior, log rotation, and upgrades. No employee-run `Start` command is part of the plan. Bind the native-facing receiver and health endpoint to loopback only; filter before off-device export or persistent queuing.
- Use detection rules for the installed version, configuration fingerprint, owned service/task, and managed policy. Monitor forwarder health and a sanitized end-to-end delivery probe separately: a listener or installation exit code is not proof of stored telemetry.
- Add bounded, signed [Intune Remediations](https://learn.microsoft.com/intune/device-management/tools/deploy-remediations) where licensed and approved. Repair only owned components; do not erase unrelated settings, override opt-outs, collect personal data, or place secrets in scripts/output. Report failure to central support if automatic repair cannot safely complete.
- Give the uninstall path explicit ownership of installed files, startup entries, and managed keys. Preserve other settings and applications. Test rollback and multi-user devices before assigning a Required deployment.

Intune requires silent installation; interactive sign-in prompts cannot be hidden inside the installer. The existing `setup-client.ps1` is **not** a ready-made Intune installer. Wrapping it in `.intunewin` does not solve startup, policy ownership, authentication, or recovery.

## Authentication release gate

The reference diagnostic forwarder obtains delegated `Telemetry.Write` tokens through the executing user's **Azure CLI** session. That is useful for controlled administrator tests, but is not the organization production enrollment plan.

Before packaging, implement and qualify an organization-approved identity design, such as a dedicated broker-backed public client with a protected per-user cache and managed lifecycle. Initial enrollment/consent, silent renewal, conditional access, expiry, revocation, logon/logoff, and offline recovery must be explicitly supported. If a device/application identity is chosen instead, implement its matching ingestion authorization; do not assume an app-only token is equivalent to the reference delegated flow. A managed installer alone authenticates neither Copilot nor the uploader.

Never distribute access/refresh tokens or shared client secrets through Intune policy, registry values, user settings, command lines, or package files. Keep filtering on the device. If an unattended runtime cannot obtain authorized credentials, fail closed for export without blocking normal Copilot use. **Do not launch a production assignment while this gate remains open.**

## Verification and release gates

1. Qualify the exact client, OS, and Local harness versions using native spans, metrics, and events; keep CLI/Agent Host/remote qualification separate. Reproduce the local portal baseline/action/difference workflow, then verify authorized delivery all the way to the cloud store.
2. Complete privacy testing beyond the current [known filter gaps](architecture.md#processing-pipeline), including arrays, links, exemplars, logs, queues, and error paths. A harmless local test is not permission to collect real-user data.
3. Test Intune install/detection/remediation/uninstall in the chosen execution contexts, repeated deployment, policy conflicts, upgrades, reboot/logon, offline reconnect, token expiry/revocation, and interrupted installation.
4. Prove unsupported/unauthorized records are rejected, approved records reach durable storage, and health reporting contains no raw telemetry or credentials. Use synthetic probes distinguishable from employee usage.
5. Approve access, retention, collection notice, support and emergency containment. The local anonymous portal is not an authenticated team service; use the Entra-protected [production mode](production-access.md) and complete its [live acceptance checklist](production-access.md#5-live-acceptance-checklist) before making analytics accessible to the organization.

## Rollback and containment

For an incident, contain the source at ingestion first; do not wait for device check-in or existing tokens to expire. Through Intune, disable the owned telemetry configuration, stop the owned forwarder/startup path, and roll back to the previously approved policy/package or uninstall it. Validate effective configuration after the appropriate reload and verify uploads have stopped. Offline devices must reconcile and requalify before re-enrollment.

Remove conflicting Required/Available install assignments before applying an [Uninstall assignment](https://learn.microsoft.com/intune/app-management/deployment/#uninstall-an-app). Remove only keys/files owned by this deployment, preserving other policy and user work. Stop disallowed persistence and apply the approved retention/deletion procedure to already-collected data; removing a client does not delete storage.

The local [restore-client.ps1](../scripts/restore-client.ps1) restores an individual developer's temporary test settings. It is not the fleet rollback mechanism and must not be distributed as an employee offboarding task.
