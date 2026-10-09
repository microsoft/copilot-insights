const { PROJECT_PATH, projectFromDocument, connectionSettings, publishWindow, identifier } = require('./context.cjs');

async function activateWithApi(vscode, context, fetcher = fetch) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.name = 'Copilot Insights project';
  status.command = 'copilotInsights.selectProject';
  status.text = '$(project) Insights: select project';
  status.tooltip = 'No project is assumed. Select the project for this window; all chats in it share that project.';
  status.show();
  context.subscriptions.push(status);
  let connection;
  let queue = Promise.resolve();
  let disposed = false;
  let configurationChanged = false;
  let lastResult;

  async function readDocument() {
    if (!folder) return undefined;
    try {
      const path = vscode.Uri.joinPath(folder.uri, PROJECT_PATH);
      if ((await vscode.workspace.fs.stat(path)).size > 4096) return undefined;
      const bytes = await vscode.workspace.fs.readFile(path);
      if (bytes.length > 4096) return undefined;
      return new TextDecoder().decode(bytes);
    } catch { return undefined; }
  }

  function register(interactive = false) {
    queue = queue.catch(() => {}).then(async () => {
      if (disposed || configurationChanged) return;
      try {
        connection ??= connectionSettings(vscode.workspace.getConfiguration('copilotInsights'));
        const project = projectFromDocument(await readDocument());
        let token;
        if (connection.authentication === 'entra') {
          const session = await vscode.authentication.getSession('microsoft', connection.scopes,
            interactive ? { createIfNone: true } : { silent: true });
          token = session?.accessToken;
        }
        lastResult = await publishWindow(connection, vscode.env.sessionId, project, token, fetcher);
        if (disposed || configurationChanged) return;
        if (lastResult.status === 'reload-required') {
          status.text = '$(debug-restart) Insights: reload for project';
          status.command = 'copilotInsights.reloadForProject';
          status.tooltip = 'This window\'s project binding is closed. New and boundary-crossing activity is unattributed. Reload before doing more Copilot work; if the window ID is reused, close and reopen the folder.';
        } else {
          status.text = project ? `$(project) Insights: ${project}` : '$(project) Insights: select project';
          status.command = 'copilotInsights.selectProject';
          status.tooltip = project ? `Project: ${project}\nAll chats in this window use this project. Click to select another; changing it requires a reload.`
            : 'Unattributed: no project is selected. Click to select one. The first workspace folder determines this window\'s project.';
        }
      } catch (error) {
        status.text = '$(warning) Insights: registration needed';
        status.command = 'copilotInsights.publishContext';
        status.tooltip = `${error.message}\nDo not assume new activity is attributed until registration succeeds.`;
        if (interactive) void vscode.window.showWarningMessage(error.message);
      }
    });
    return queue;
  }

  function invalidateWindow(reason, interactive = false) {
    configurationChanged = true;
    status.text = `$(debug-restart) Insights: reload for ${reason}`;
    status.command = 'copilotInsights.reloadForProject';
    status.tooltip = 'Closing the old window binding. Reload before continuing Copilot work; this window will not retarget a service or workspace.';
    queue = queue.catch(() => {}).then(async () => {
      if (disposed || !connection) return;
      try {
        const token = connection.authentication === 'entra'
          ? (await vscode.authentication.getSession('microsoft', connection.scopes, interactive ? { createIfNone: true } : { silent: true }))?.accessToken : undefined;
        await publishWindow(connection, vscode.env.sessionId, null, token, fetcher);
        if (!disposed) status.tooltip = 'The old window binding is closed or unattributed. Reload before continuing Copilot work.';
      } catch {
        if (!disposed) {
          status.text = '$(warning) Insights: close old binding';
          status.command = 'copilotInsights.publishContext';
          status.tooltip = 'The previous service could not acknowledge closing this window. Stop Copilot work, restore the connection/sign-in, and click to retry before changing workspaces or endpoints.';
        }
      }
    });
    return queue;
  }

  async function setProject(project) {
    if (!folder) { void vscode.window.showWarningMessage('Open a folder before selecting a project.'); return; }
    const directory = vscode.Uri.joinPath(folder.uri, '.copilot-insights');
    await vscode.workspace.fs.createDirectory(directory);
    const ignorePath = vscode.Uri.joinPath(directory, '.gitignore');
    try { await vscode.workspace.fs.stat(ignorePath); }
    catch { await vscode.workspace.fs.writeFile(ignorePath, new TextEncoder().encode('*\n')); }
    const document = await readDocument();
    const previous = projectFromDocument(document);
    let existing = {};
    try { const parsed = JSON.parse(document); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed; } catch {}
    const next = { ...existing, project, updatedAt: new Date().toISOString() };
    if (!project) delete next.project;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, PROJECT_PATH), new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`));
    await register(true);
    let choice;
    if (lastResult?.status === 'reload-required') {
      choice = await vscode.window.showWarningMessage('The project changed. Reload this window before continuing Copilot work.', 'Reload window');
    } else if (!previous && project && lastResult?.status === 'active') {
      choice = await vscode.window.showInformationMessage(`Project set to ${project}. Reload this window so its Copilot work starts under this project.`, 'Reload window');
    }
    if (choice === 'Reload window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  async function selectProject() {
    if (!folder) { void vscode.window.showWarningMessage('Open a folder before selecting a project.'); return; }
    const project = await vscode.window.showInputBox({
      title: 'Copilot Insights: project for this window', value: projectFromDocument(await readDocument()) ?? '', ignoreFocusOut: true,
      prompt: 'A project ID such as contoso.alpha. Only this ID and the window ID are registered.',
      validateInput: (value) => identifier.test(value) ? undefined : 'Use 1-128 letters, digits, dots, underscores, or hyphens, starting with a letter or digit.',
    });
    if (project) await setProject(project);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotInsights.selectProject', selectProject),
    vscode.commands.registerCommand('copilotInsights.clearProject', () => setProject(null)),
    vscode.commands.registerCommand('copilotInsights.publishContext', () => configurationChanged ? invalidateWindow('pending change', true) : register(true)),
    vscode.commands.registerCommand('copilotInsights.reloadForProject', () => vscode.commands.executeCommand('workbench.action.reloadWindow')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('copilotInsights')) return invalidateWindow('settings');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => invalidateWindow('workspace')),
  );
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, PROJECT_PATH));
    context.subscriptions.push(watcher, watcher.onDidCreate(() => register()), watcher.onDidChange(() => register()), watcher.onDidDelete(() => register()));
  }
  const timer = setInterval(() => { void register(); }, 30_000);
  timer.unref?.();
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); } });
  await register();
  return { register, setProject, readProject: async () => projectFromDocument(await readDocument()) };
}

async function activate(context) { return activateWithApi(require('vscode'), context); }
module.exports = { activate, activateWithApi };
