import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { InputBoxOptions, WorkspaceConfiguration } from 'vscode';
import { PROJECT_PATH, projectFromDocument, connectionSettings, publishWindow, type Fetcher } from '../context.ts';
import { activateWithApi } from '../extension.ts';

type Handler = (...args: any[]) => unknown;

const defaults: Record<string, string> = { endpoint: 'http://127.0.0.1:3000', authentication: 'local', tenantId: '', clientId: '', apiAudience: '' };
const documentPath = `workspace-first/${PROJECT_PATH}`;
const configuration = (values: Record<string, string> = {}, workspace: Record<string, string> = {}) =>
  ({ inspect: (key: string) => ({ defaultValue: defaults[key], globalValue: values[key], workspaceValue: workspace[key] }) }) as unknown as WorkspaceConfiguration;

test('only a valid project ID is read from the generic project file; missing and malformed documents stay unattributed', () => {
  assert.equal(PROJECT_PATH, '.copilot-insights/project.json');
  for (const text of [undefined, '', '{}', '{invalid', '[]', '{"project":""}', '{"project":"../escape"}', '{"project":42}', '{"project":"has space"}']) {
    assert.equal(projectFromDocument(text), null);
  }
  assert.equal(projectFromDocument(JSON.stringify({ project: 'contoso.alpha', token: 'PRIVATE-CANARY', url: 'https://private.invalid' })), 'contoso.alpha');
});

test('workspace files cannot retarget the publisher or downgrade production authentication', () => {
  assert.equal(connectionSettings(configuration({}, { endpoint: 'https://foreign.invalid', authentication: 'entra' })).endpoint, defaults.endpoint);
  for (const endpoint of ['https://remote.example.test', 'http://user:password@localhost:3000', 'http://localhost:3000/path', 'http://localhost:3000/?token=secret']) {
    assert.throws(() => connectionSettings(configuration({ endpoint })));
  }
  const settings = { endpoint: 'https://insights.example.test', authentication: 'entra', tenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222', apiAudience: '33333333-3333-4333-8333-333333333333' };
  const connection = connectionSettings(configuration(settings));
  assert.deepEqual(connection.scopes, [`api://${settings.apiAudience}/Context.Publish`, `VSCODE_CLIENT_ID:${settings.clientId}`, `VSCODE_TENANT:${settings.tenantId}`]);
  assert.throws(() => connectionSettings(configuration({ ...settings, endpoint: 'http://insights.example.test' })));
});

test('registration uses the native window ID, sends only the project ID and device time, and forbids redirects', async () => {
  const connection = connectionSettings(configuration());
  const result = await publishWindow(connection, 'native-window', 'contoso.alpha', undefined, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3000/api/context/windows');
    assert.equal(options.redirect, 'error');
    assert.equal((options.headers as Record<string, string>).Authorization, undefined);
    const { clientTime, ...body } = JSON.parse(options.body as string);
    assert.deepEqual(body, { sessionId: 'native-window', project: 'contoso.alpha' });
    assert.ok(Number.isSafeInteger(clientTime) && Math.abs(clientTime - Date.now()) < 60_000);
    return Response.json({ sessionId: 'native-window', status: 'active' });
  });
  assert.equal(result.status, 'active');
  await assert.rejects(publishWindow({ ...connection, authentication: 'entra' }, 'native-window', 'contoso.alpha', undefined), /Sign in/);
  assert.equal((await publishWindow(connection, 'native-window', null, undefined, async () => Response.json({ sessionId: 'native-window', status: 'reload-required' }, { status: 409 }))).status, 'reload-required');
  await assert.rejects(publishWindow(connection, 'native-window', 'contoso.alpha', undefined,
    async () => Response.json({ error: { code: 'clock-skew', message: 'PRIVATE-CANARY' } }, { status: 400 })), (error: Error) => /device clock/.test(error.message) && !error.message.includes('PRIVATE-CANARY'));
});

function mockEditor(context: TestContext, documents = new Map<string, string>()) {
  const handlers = new Map<string, Handler>();
  const subscriptions: { dispose(): void }[] = [];
  const requests: { sessionId?: string; project?: string | null }[] = [];
  const status: { show(): void; dispose(): void; text?: string; command?: string; tooltip?: string } = { show() {}, dispose() {} };
  const disposable = () => ({ dispose() {} });
  const api: any = {
    env: { sessionId: 'native-editor-window' },
    Uri: { joinPath: (base: string, ...parts: string[]) => [base, ...parts].join('/') },
    RelativePattern: class { folder: unknown; pattern: string; constructor(folder: unknown, pattern: string) { this.folder = folder; this.pattern = pattern; } },
    StatusBarAlignment: { Left: 1 },
    window: { createStatusBarItem: () => status, showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, showInputBox: async () => undefined },
    commands: { executeCommand: async () => {}, registerCommand: (name: string, callback: Handler) => { handlers.set(name, callback); return disposable(); } },
    workspace: {
      workspaceFolders: [{ uri: 'workspace-first' }, { uri: 'workspace-second' }],
      getConfiguration: () => configuration(),
      onDidChangeConfiguration: (callback: Handler) => { handlers.set('configuration-change', callback); return disposable(); },
      onDidChangeWorkspaceFolders: (callback: Handler) => { handlers.set('workspace-change', callback); return disposable(); },
      createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }),
      fs: { stat: async (path: string) => { if (!documents.has(path)) throw new Error('Missing'); return { size: Buffer.byteLength(documents.get(path)!) }; },
        readFile: async (path: string) => { if (!documents.has(path)) throw new Error('Missing'); return Buffer.from(documents.get(path)!); },
        createDirectory: async () => {}, writeFile: async (path: string, value: Uint8Array) => documents.set(path, Buffer.from(value).toString()) },
    },
  };
  context.after(() => subscriptions.forEach((entry) => entry.dispose()));
  const fetcher: Fetcher = async (url, options) => {
    const { clientTime, ...body } = JSON.parse(options.body as string);
    assert.ok(Number.isSafeInteger(clientTime));
    requests.push(body);
    return Response.json({ sessionId: body.sessionId, status: body.project ? 'active' : 'unattributed' });
  };
  return { api, documents, requests, handlers, status, context: { subscriptions }, fetcher };
}

test('the status bar sets the generic project file, keeps it out of source control, and registers only the project ID', async (context) => {
  const editor = mockEditor(context, new Map([
    [documentPath, JSON.stringify({ project: 'contoso.alpha', localOnly: 'PRIVATE-CANARY' })],
    [`workspace-second/${PROJECT_PATH}`, JSON.stringify({ project: 'not-this-window' })],
  ]));
  let prompt: InputBoxOptions | undefined;
  editor.api.window.showInputBox = async (options: InputBoxOptions) => { prompt = options; return 'contoso.beta'; };
  const extension = await activateWithApi(editor.api, editor.context, editor.fetcher);
  assert.deepEqual(editor.requests[0], { sessionId: editor.api.env.sessionId, project: 'contoso.alpha' });
  await editor.handlers.get('copilotInsights.selectProject')!();
  assert.equal(prompt!.value, 'contoso.alpha');
  assert.notEqual(prompt!.validateInput!('../escape'), undefined);
  assert.equal(prompt!.validateInput!('contoso.beta'), undefined);
  const document = JSON.parse(editor.documents.get(documentPath)!);
  assert.equal(document.project, 'contoso.beta');
  assert.equal(document.localOnly, 'PRIVATE-CANARY');
  assert.ok(document.updatedAt);
  assert.equal(editor.documents.get('workspace-first/.copilot-insights/.gitignore'), '*\n');
  assert.deepEqual(editor.requests.at(-1), { sessionId: editor.api.env.sessionId, project: 'contoso.beta' });
  assert.ok(editor.requests.every((request) => !JSON.stringify(request).includes('PRIVATE-CANARY')));
  await editor.handlers.get('copilotInsights.clearProject')!();
  assert.equal(editor.requests.at(-1)!.project, null);
  assert.equal(await extension.readProject(), null);
});

test('an existing project-folder ignore file is left to the repository owner', async (context) => {
  const ignorePath = 'workspace-first/.copilot-insights/.gitignore';
  const editor = mockEditor(context, new Map([[ignorePath, '!project.json\n']]));
  const extension = await activateWithApi(editor.api, editor.context, editor.fetcher);
  await extension.setProject('contoso.alpha');
  assert.equal(editor.documents.get(ignorePath), '!project.json\n');
});

test('the first selection prompts for a reload so the window starts under the project', async (context) => {
  const editor = mockEditor(context);
  const prompts: string[] = [];
  const executed: string[] = [];
  editor.api.window.showInformationMessage = async (message: string, ...actions: string[]) => { prompts.push(message); return actions[0]; };
  editor.api.commands.executeCommand = async (command: string) => { executed.push(command); };
  const extension = await activateWithApi(editor.api, editor.context, editor.fetcher);
  await extension.setProject('contoso.alpha');
  assert.equal(editor.status.text, '$(project) Insights: contoso.alpha');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /contoso\.alpha/);
  assert.deepEqual(executed, ['workbench.action.reloadWindow']);
  await extension.setProject('contoso.alpha');
  assert.equal(prompts.length, 1);
});

test('changing an active project asks for a reload instead of moving the running window', async (context) => {
  const editor = mockEditor(context, new Map([[documentPath, JSON.stringify({ project: 'contoso.alpha' })]]));
  const executed: string[] = [];
  editor.api.commands.executeCommand = async (command: string) => { executed.push(command); };
  editor.api.window.showWarningMessage = async (message: string, ...actions: string[]) => actions[0];
  const extension = await activateWithApi(editor.api, editor.context, async (url, options) => {
    const body = JSON.parse(options.body as string);
    editor.requests.push(body);
    return body.project === 'contoso.alpha' ? Response.json({ sessionId: body.sessionId, status: 'active' })
      : Response.json({ sessionId: body.sessionId, status: 'reload-required' }, { status: 409 });
  });
  await extension.setProject('contoso.beta');
  assert.equal(editor.status.command, 'copilotInsights.reloadForProject');
  assert.deepEqual(executed, ['workbench.action.reloadWindow']);
});

test('workspace and connection changes close the previous binding without retargeting the publisher', async (context) => {
  for (const event of ['configuration-change', 'workspace-change']) {
    const editor = mockEditor(context, new Map([[documentPath, JSON.stringify({ project: 'contoso.alpha' })]]));
    const destinations: string[] = [];
    const extension = await activateWithApi(editor.api, editor.context, async (url, options) => {
      destinations.push(url);
      return editor.fetcher(url, options);
    });
    editor.api.workspace.getConfiguration = () => configuration({ endpoint: 'http://localhost:7777' });
    editor.api.workspace.workspaceFolders = [{ uri: 'different-workspace' }];
    await editor.handlers.get(event)!({ affectsConfiguration: () => true });
    assert.equal(editor.requests.length, 2);
    assert.equal(editor.requests[1].project, null);
    assert.ok(destinations.every((url) => url === 'http://127.0.0.1:3000/api/context/windows'));
    assert.equal(editor.status.command, 'copilotInsights.reloadForProject');
    await extension.register();
    assert.equal(editor.requests.length, 2);
  }
});

test('oversized project documents stay unread and unattributed', async (context) => {
  const editor = mockEditor(context, new Map([[documentPath, JSON.stringify({ project: 'contoso.alpha', oversized: 'x'.repeat(4096) })]]));
  const readFile = editor.api.workspace.fs.readFile;
  let reads = 0;
  editor.api.workspace.fs.readFile = async (path: string) => { reads++; return readFile(path); };
  await activateWithApi(editor.api, editor.context, editor.fetcher);
  assert.equal(editor.requests[0].project, null);
  assert.equal(reads, 0);
});

test('a failed old-binding closure stays visible and can be retried before a reload', async (context) => {
  const editor = mockEditor(context, new Map([[documentPath, JSON.stringify({ project: 'contoso.alpha' })]]));
  let available = true;
  await activateWithApi(editor.api, editor.context, (url, options) => {
    if (!available) throw new Error('Offline');
    return editor.fetcher(url, options);
  });
  available = false;
  await editor.handlers.get('workspace-change')!();
  assert.equal(editor.status.command, 'copilotInsights.publishContext');
  assert.match(editor.status.tooltip!, /could not acknowledge/);
  available = true;
  await editor.handlers.get('copilotInsights.publishContext')!();
  assert.equal(editor.requests.at(-1)!.project, null);
  assert.equal(editor.status.command, 'copilotInsights.reloadForProject');
  assert.match(editor.status.tooltip!, /closed or unattributed/);
});
