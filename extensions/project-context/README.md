# Copilot Insights Project Context

A small VS Code companion for the [Copilot Insights service](../../README.md). It lets you select the project for each window from the status bar, stores the choice in the first workspace folder's `.copilot-insights/project.json`, and registers `vscode.env.sessionId` with that project. Missing configuration stays **Unattributed**. It does not emit fake Copilot events or change native OTel resource settings.

For local development, start the service and launch a disposable folder with:

```powershell
$extensionPath = (Resolve-Path ./extensions/project-context).Path
code --new-window --extensionDevelopmentPath $extensionPath '<disposable-folder>'
```

Click **Insights: select project** in the status bar, or run **Copilot Insights: Select Project**, and enter a project ID such as `contoso.alpha`. The first selection applies immediately and then prompts for a reload so the window's session starts under the project; reload after changing or clearing it, and close/reopen the window if its native session ID is reused. Multiple chats inherit their window's project, while distinct workspaces/windows can select different projects.

Other tools can set the project by writing `.copilot-insights/project.json`; the companion watches that file. See [project attribution](../../docs/projects.md), [production publisher configuration](../../docs/production-access.md), and [the Intune rollout plan](../../docs/intune-deployment.md). Production publication uses the built-in Microsoft authentication provider and requires `Insights.Publisher`, not administrator access. Package with an approved `@vscode/vsce` toolchain for managed deployment; source-loaded development is not the production installation plan.

## Validation

`npm test` runs isolated unit tests with a mocked VS Code API. The optional `tests/native-smoke.cjs` runner is for maintainers using VS Code's extension test host in a **trusted disposable** `copilot-insights-native-*` folder. It requires `hello.txt`, an explicit `native-validation.json` approval (`{"allowReadOnlyCopilotTasks":true,"chats":1}` or `2`), a selected sample project, native Local Copilot sign-in, and reversible local OTLP setup. It performs real read-only Copilot chats and records a result in that disposable folder; it never posts synthetic OTLP. Normal trust/sign-in/tool approvals still apply. Unit tests are not a native-emission claim.
