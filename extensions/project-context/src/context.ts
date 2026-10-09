import type { WorkspaceConfiguration } from 'vscode';

export interface Connection {
  endpoint: string;
  authentication: 'local' | 'entra';
  scopes: string[];
}

export interface Registration {
  sessionId: string;
  status: 'active' | 'unattributed' | 'reload-required';
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export const PROJECT_PATH = '.copilot-insights/project.json';
export const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function projectFromDocument(text: string | undefined): string | null {
  try {
    const value = JSON.parse(text as string);
    return value && typeof value.project === 'string' && identifier.test(value.project) ? value.project : null;
  } catch { return null; }
}

export function connectionSettings(configuration: Pick<WorkspaceConfiguration, 'inspect'>): Connection {
  const read = (key: string) => configuration.inspect<string>(key)?.globalValue ?? configuration.inspect<string>(key)?.defaultValue;
  const endpoint = new URL(read('endpoint') as string);
  const authentication = read('authentication');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Configure only the Insights service origin, without a path or credentials.');
  if (authentication === 'local') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol)) {
      throw new Error('Unauthenticated mode is limited to loopback. Production endpoints require Entra authentication.');
    }
    return { endpoint: endpoint.origin, authentication, scopes: [] };
  }
  const tenantId = read('tenantId');
  const clientId = read('clientId');
  const audience = read('apiAudience');
  if (authentication !== 'entra' || endpoint.protocol !== 'https:' || ![tenantId, clientId, audience].every((value) => typeof value === 'string' && guid.test(value))) {
    throw new Error('Production requires HTTPS plus tenant, client, and API audience GUIDs configured by your administrator.');
  }
  return { endpoint: endpoint.origin, authentication, scopes: [`api://${audience}/Context.Publish`, `VSCODE_CLIENT_ID:${clientId}`, `VSCODE_TENANT:${tenantId}`] };
}

export async function publishWindow(connection: Connection, sessionId: string, project: string | null, token: string | undefined,
  fetcher: Fetcher = fetch): Promise<Registration> {
  if (connection.authentication === 'entra' && !token) throw new Error('Sign in to register this window. The Insights.Publisher role is required.');
  const response = await fetcher(`${connection.endpoint}/api/context/windows`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ sessionId, project, clientTime: Date.now() }),
  });
  const result = await response.json();
  if (!response.ok && !(response.status === 409 && result.status === 'reload-required')) {
    throw new Error(response.status === 403 ? 'Registration denied. Ask an administrator to validate your Insights.Publisher role assignment.'
      : response.status === 401 ? 'Sign in again with an access token for this Insights API.'
        : result.error?.code === 'clock-skew' ? 'This device clock differs from the Insights service by more than 5 minutes. Synchronize it, then retry.'
          : 'Window registration failed. Check the configured Insights service.');
  }
  if (!['active', 'unattributed', 'reload-required'].includes(result.status) || result.sessionId !== sessionId) throw new Error('The service returned an invalid registration response.');
  return result;
}
