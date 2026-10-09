import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PROJECT_KEY_PATTERN } from './context.mjs';
import { AppError } from './errors.mjs';

const organization = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional();
const project = z.string().regex(PROJECT_KEY_PATTERN).default('all');
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createInsightsMcp({ organizations, projects, snapshot }) {
  const server = new McpServer({ name: 'copilot-insights-admin', version: '0.1.0' });
  const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const guarded = (callback) => async (input) => {
    try { return result(await callback(input)); }
    catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof AppError ? error.message : 'The report is unavailable. No substitute data is returned.' }] };
    }
  };
  server.registerTool('list_organizations', {
    title: 'List insight organizations',
    description: 'List configured organizations. Demo data is fictional and never represents collected activity.',
    inputSchema: z.object({}).strict(), annotations,
  }, guarded(async () => ({ organizations })));
  server.registerTool('list_projects', {
    title: 'List project scopes',
    description: 'List project keys within one organization. Unattributed activity has no selected or safely registered project.',
    inputSchema: z.object({ organization }).strict(), annotations,
  }, guarded(async (input) => projects(input.organization)));
  server.registerTool('get_insights_report', {
    title: 'Analyze an insights report',
    description: 'Read metadata-only usage, model/tool breakdowns, findings, review statuses, and correlation/coverage diagnostics. Filter by a key from list_projects. No prompts, code, raw OTLP, user identities, filesystem access, or review mutations. Token counts are observations, not cost or productivity scores.',
    inputSchema: z.object({ organization, project, days: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(7) }).strict(), annotations,
  }, guarded(async (input) => snapshot(input.organization, input.days, input.project)));
  return server;
}

export async function handleMcp(request, response, body, services) {
  const server = createInsightsMcp(services);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.once('close', () => { void server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    await server.close();
    throw error;
  }
}
