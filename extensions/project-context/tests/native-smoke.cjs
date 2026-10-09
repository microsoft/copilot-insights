const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const { basename, join } = require('node:path');
const vscode = require('vscode');

async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder || !basename(folder).startsWith('copilot-insights-native-')) throw new Error('Native tests require a dedicated disposable sample workspace.');
  const output = join(folder, 'native-result.json');
  try {
    assert.ok(vscode.workspace.isTrusted, 'Trust only this disposable sample folder, then rerun native verification. Workspace trust is never disabled by this test.');
    const options = JSON.parse(await readFile(join(folder, 'native-validation.json'), 'utf8'));
    assert.equal(options.allowReadOnlyCopilotTasks, true);
    assert.ok([1, 2].includes(options.chats));
    const extension = vscode.extensions.getExtension('copilot-insights.copilot-insights-project');
    assert.ok(extension, 'Project companion is not loaded.');
    const api = await extension.activate();
    await api.register();
    const selected = await api.readProject();
    const catalog = await (await fetch('http://127.0.0.1:3000/api/projects?organization=local-vscode')).json();
    const project = catalog.projects.find((entry) => entry.project === selected);
    assert.ok(project, 'Window registration was not persisted.');
    const copilot = vscode.extensions.getExtension('GitHub.copilot-chat');
    assert.ok(copilot, 'Native Copilot Chat is not installed.');
    await copilot.activate();
    const readTools = vscode.lm.tools.filter((tool) => ['read_file', 'copilot_readFile'].includes(tool.name)).map((tool) => tool.name);
    assert.ok(readTools.length, 'No native file-reading tool is available.');
    for (let index = 0; index < options.chats; index++) {
      await vscode.commands.executeCommand('workbench.action.chat.newChat');
      const result = await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: 'Use the file-reading tool to read hello.txt in this disposable workspace, then report its one line. Do not run terminal commands, edit files, use network tools, or read any other file.',
        mode: 'agent', blockOnResponse: true, toolsInclude: readTools,
      });
      if (result?.errorDetails || result?.type === 'confirmation') throw new Error('Native Copilot needs sign-in, model access, or user confirmation.');
    }
    const deadline = Date.now() + 90_000;
    let report;
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:3000/api/insights?organization=local-vscode&project=${project.id}&days=7`);
      assert.ok(response.ok, 'Insights API is unavailable.');
      report = await response.json();
      if (report.summary.calls >= options.chats && report.summary.toolCalls >= options.chats && report.correlation.conversations >= options.chats) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.ok(report.summary.calls >= options.chats, 'Native model spans were not captured for the registered project.');
    assert.ok(report.summary.toolCalls >= options.chats, 'Native file-reading tools were not captured.');
    assert.ok(report.correlation.conversations >= options.chats, 'Separate native chats did not appear in the same project.');
    assert.equal(report.correlation.sessions, 1, 'A project contains an unexpected window.');
    assert.equal(report.quality.fixtureTaggedSpans, 0, 'Synthetic fixtures contaminated the native exercise.');
    await writeFile(output, JSON.stringify({ status: 'passed', sessionId: vscode.env.sessionId, projectKey: project.id,
      chats: options.chats, modelCalls: report.summary.calls, toolCalls: report.summary.toolCalls, conversations: report.correlation.conversations,
      windows: report.correlation.sessions, attributedSpans: report.quality.attributedSpans, fixtureTaggedSpans: report.quality.fixtureTaggedSpans }, null, 2));
  } catch (error) {
    await writeFile(output, JSON.stringify({ status: 'failed', message: error.message }, null, 2));
    throw error;
  }
}

module.exports = { run };
