# Admin MCP reports

The insights service includes a read-only [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) MCP server at **`/mcp`**, using stateless Streamable HTTP and JSON responses. It uses the same normalization, organization/project filters, signal IDs, and review store as the portal. There is no second analytics implementation or raw-telemetry tool.

## Local connection

Start the [local stack](../README.md#try-it-on-your-machine) first. A VS Code MCP configuration can contain:

```json
{
  "servers": {
    "copilot-insights-admin": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Local mode intentionally has no Entra authentication. Bind published ports to loopback; this is not an anonymous shared service. Use an approved MCP client/model: although this server does not call an external model, the MCP client can send returned report metadata to its configured model provider.

## Tools

| Tool | Inputs | Result |
|---|---|---|
| `list_organizations` | None | The configured collector organization, plus the demo in local mode |
| `list_projects` | Optional `organization` | Keys for all/unattributed and registered projects; omitted organization selects the first listed (the demo in local mode, the collector organization in production) |
| `get_insights_report` | Optional `organization`, `project`, `days` (7, 14, 30) | Summary, trend, model/tool breakdowns, findings, saved review statuses, correlation, and coverage |

Start by listing scopes rather than inventing keys. Example admin request: “List organizations, find sample-alpha in the demo organization, and explain its seven-day error and token-coverage findings. Do not infer productivity or cost from token counts.”

All tools declare read-only, non-destructive annotations. Unknown organizations, cross-organization project keys, duplicate/unsupported HTTP filters, arbitrary paths, and extra tool arguments are rejected. Tools cannot edit review decisions, change memberships, retrieve credentials, access arbitrary files, or expose prompts/code/raw OTLP. A failed report returns an error, not demo fallback data. Review tokens are never included in MCP results.

## Production authorization

Follow [Production access](production-access.md) before exposing this endpoint. Each HTTP request requires an API access token with **`Insights.Admin`**. Delegated user tokens also need **`Insights.Read`**. Assigned application identities may use app-only access tokens with `idtyp=app` and the admin application permission. Native window registration uses a separate publisher role and cannot read these reports.

App-only admin access is read-only even outside the MCP surface: human-review writes require delegated admin sign-in, and context publishing requires a delegated publisher. The server advertises OAuth Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp` (also at the root discovery path). An MCP `401` response includes a `WWW-Authenticate` challenge pointing to it. Metadata names the tenant-specific Entra authorization server, MCP resource, and `api://<api-app-id>/Insights.Read` scope. Tokens must target the **API application ID**, not Microsoft Graph, Azure Resource Manager, the portal client, or the collector-ingestion API.

Use a statically registered Entra client authorized for that delegated scope, authorization code + PKCE, and the exact redirect URI required by your MCP client. This service is a resource server, not an OAuth issuer: it does **not** implement dynamic client registration or accept tokens supplied for an unrelated API. Configure client ID/tenant through your MCP client's supported OAuth settings; clients that only support dynamic registration need a compatible client configuration or approved adapter. Never paste a long-lived bearer token into a committed MCP configuration.

There is no reusable privileged MCP session ID. Initialization, discovery, and tool calls all pass the same JWT/role checks; a prior successful initialization cannot authorize a later request with a missing role. GET/SSE and DELETE sessions are not provided (`405`); POST notifications are accepted by the SDK.

## Validation

[Security/MCP tests](../apps/insights/tests/security-mcp.test.mjs) use the official MCP client against a real HTTP listener, including initialization, tool discovery, scoped reports, invalid tool arguments, and a role removal between requests. Production-mode tests verify signed RSA JWTs using an isolated test JWKS, not an authentication bypass. These tests **do not prove live Entra consent, sign-in, or tenant role assignment**; use the production acceptance checklist for those gates.
