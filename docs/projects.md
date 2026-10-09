# Project attribution

The hierarchy is **collector organization → project**. The native VS Code window ID binds a window to one project; every chat in that window inherits it. A project is a routing label, **not an authorization grant**. Production report access is controlled separately by [Entra app roles](production-access.md).

## Select a project in VS Code

The [project companion](../extensions/project-context) adds a status-bar item to each window. Click **Insights: select project**, or run **Copilot Insights: Select Project**, and enter the project ID. **Copilot Insights: Clear Project (Unattributed)** removes the selection. **Copilot Insights: Register This Window** retries registration or signs in as a publisher.

The selection is stored in the first workspace folder's `.copilot-insights/project.json`:

```json
{
  "project": "sample-alpha",
  "updatedAt": "2026-10-03T12:00:00Z"
}
```

Project IDs are 1–128 letters, digits, dots, underscores, or hyphens, starting with a letter or digit, such as `contoso.alpha`. Use a convention such as `<team>.<project>` where names could collide. Missing, unreadable, oversized (over 4 KiB), or malformed documents mean **Unattributed**, never a guessed project. Only `project` is read; other properties stay on the machine.

- When the companion creates `.copilot-insights/`, it adds a `.gitignore` containing `*`, keeping the selection out of source control. An existing `.gitignore` in that folder is left unchanged, so a team can deliberately share a default project. Ignore rules do not untrack an already committed file. This repository also ignores `.copilot-insights` folders.
- Multi-root workspaces use their **first folder**, not whichever editor has focus. Two windows on different folders can select different projects. Windows on the same folder share the same file; independent selections require separate folders.

## Set the project from another tool

The status bar is optional. Another tool can write `.copilot-insights/project.json` in the first workspace folder; the companion watches the file and registers the change. An organization's existing project or work-tracking tooling can map its own identifiers to a project ID this way. Copilot Insights does not read other tools' configuration files.

For a local source run, launch VS Code with `--extensionDevelopmentPath` pointing at the companion, as shown in the [README walkthrough](../README.md#2-enable-logging-and-do-a-small-vs-codecopilot-task). Extension settings are machine-scoped; workspace configuration cannot change the service origin or authentication mode. Remote/SSH/WSL development runs the workspace extension in that environment, so its loopback address must reach a qualified local service there. Remote runtime qualification is not implied by a desktop test.

## Registration, not a fabricated native event

The companion posts `{ "sessionId": "<vscode.env.sessionId>", "project": "<id>", "clientTime": <epoch ms> }` to `/api/context/windows` when the window starts, when the selection changes, and every 30 seconds while the window is open. A missing selection is sent as `null`. This is a separate context-registration API, **not OTLP and not a Copilot model/tool event**.

Native Copilot continues to emit the documented resource `session.id` and per-chat `gen_ai.conversation.id`. The collector already retains these fields. The portal joins normalized spans to its persisted window registry; it does not overwrite native IDs, mutate Copilot's application-wide OTel settings per project, stamp entire batches with a global project, or require a native per-chat observation API.

The canonical `prj-…` key hashes **organization + project ID**, so the same project ID in different collector organizations stays separate. The human-readable project ID accompanies it in the protected catalog.

The collector, not the companion request, selects the organization. Client resource attributes claiming a project are not authoritative and do not replace the registration. Production publishers are authenticated, and only the principal that created a binding can change it. They still supply self-declared metadata: this is neither endpoint attestation nor server-side membership validation. An `Insights.Admin` assignment grants access to all project scopes in that service organization; per-project admin ACLs are not implemented.

## Safe switching and delayed exports

1. Registration is serialized and persisted. Its boundary is the **device time** sent with the request, because native span timestamps also come from the device clock. A device clock more than five minutes from the service clock is refused (HTTP `400`, `clock-skew`) and new activity stays unattributed until the clock is synchronized. Already-collected activity, spans started before registration, and spans with no trustworthy start time remain unattributed.
2. A window without a project has no binding. Its **first** selected project applies immediately; activity before that selection, including spans that cross it, stays unattributed. The companion then prompts for a reload so the window's whole session starts under the project. Declining keeps the attribution that began at the selection.
3. Re-registering the same window and project is idempotent; reconnects do not move the start boundary.
4. A later different selection, including clearing it, **closes** the binding and returns HTTP `409` / `reload-required`. The same window ID cannot be reopened or assigned to a second project while its binding is retained.
5. Reload before more Copilot activity. If the client retains its window ID, close and reopen the window instead. The new window registers its project afresh; a persisted document alone is not proof of registration.
6. Delayed spans wholly within the old binding interval retain that project. Spans crossing the close boundary, or starting after it, remain unattributed. Closed bindings stay persisted for delayed export and historical review.

Wait for the status bar to confirm registration and stop Copilot work while a change is pending. A failed/unreachable registration cannot acknowledge closing an old binding; do not interpret the on-disk selection as an effective remote change until the service responds. Within the five-minute tolerance, a publisher could place its own boundary up to five minutes early; projects are routing labels, not authorization. A process restart is safe with the same persisted registry; deleting that volume loses historical attribution.

Changing workspace folders or publisher connection settings also asks the previous service to close the old binding, then requires a reload. The running window never starts publishing to a new endpoint. If the old service is unavailable, the status bar warns that closure was not acknowledged; stop work rather than assume attribution changed.

Each registration renews its window's binding at most once a day. A binding is removed 32 days after its window last contacted the service: by then its spans are outside every 7-, 14-, or 30-day report. Windows without a project are never stored. The registry has a 10,000-window / 8 MiB evaluation limit for windows active within that period and fails closed when unreadable or full. Back up the registry together with telemetry. One service process owns each registry/review volume. Distributed writers require a shared storage implementation.

## What the portal counts

**Organization** chooses the collector dataset. **Project** chooses all, unattributed, or one registered scope. Selection never falls back to the demo or another project when it is empty or invalid. The demo has independent fictional projects, `sample-alpha` and `sample-beta`, and never receives native uploads.

Span-based model calls, tool executions, token counts, latency, feedback correlation, findings, and review identities are filtered by the project key. Two chats in one window remain distinguishable by conversation ID without requiring two project registrations. Review signal IDs include the selected project filter, so a decision for one project is not inherited by **All projects** or another project. Evidence that arrives after a decision is flagged as new rather than resetting it. Legacy reviews remain stored but do not silently acquire a project.

Cumulative OTel metric aggregates cannot safely be split on a project switch. They are **not** added to project totals. Replay/metric/log file diagnostics remain explicitly organization-wide; attributed and unattributed accepted-span counts describe the selected scope.

## Privacy boundary

Only the native window ID and the validated project ID leave the companion. It never sends source paths, the project document, credentials, prompts, or code. Project IDs and native correlation IDs are still potentially sensitive metadata, not anonymized data; avoid customer names or personal data in project IDs. The private registry additionally retains the publishing principal's tenant/object ID to enforce ownership; those IDs are not returned in analytics or MCP reports. Keep state volumes and tokens out of source control.
