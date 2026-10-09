# Production admin access with Microsoft Entra ID

The service has two explicit modes. **Local** has no Entra authentication and must stay on loopback. **Production** requires tenant-specific Entra access tokens, an API audience, and app roles for every analytics/review API and MCP request. Missing production configuration prevents startup; there is no anonymous fallback.

This implements an authentication/authorization boundary, **not a production-readiness claim**. The single-writer review/window stores, collector privacy gaps, fleet enrollment, and live tenant qualification remain release gates. The [Azure template](infrastructure.md#deploy-from-your-checkout) can deploy this portal in production mode with `deployInsights = true`; it reads the usage workspace through a managed identity instead of a capture file. The template does not create the Entra app registrations below. That cloud path has not been verified against a live tenant and workspace.

## Separate identities and permissions

| Caller | API permission | Required app role | Allowed operations |
|---|---|---|---|
| Human portal/MCP administrator | Delegated `Insights.Read` | `Insights.Admin` | Read all project reports within the service's organization; the portal can save review statuses |
| Approved app-only MCP automation | Admin application permission; token includes `idtyp=app` | `Insights.Admin` | Read report APIs/tools; no human-review writes or context publishing |
| VS Code project companion | Delegated `Context.Publish` | `Insights.Publisher` | Register/close only that publishing principal's window bindings; no report access |
| Native OTLP uploader | Separate approved ingestion API/forwarder identity | Separate ingestion authorization | Send sanitized telemetry; neither portal sign-in nor context registration authenticates OTLP |

`Insights.Admin` is an **Entra application role**, not Azure subscription Owner/Contributor, a directory role, a group display name, or a label in a workspace project file. Being allowed to select or publish a project does not grant report access. Admin authorization currently covers the entire configured organization, not individual projects. Deploy separate service/storage boundaries where per-project admin isolation is required.

## 1. Register the API

An identity administrator creates a **single-tenant** API application and its enterprise application in the intended tenant. Use a new service-specific identity rather than reusing the collector-ingestion app.

1. Set the identifier URI to `api://<api-application-client-id>` and requested access-token version to `2`.
2. Define the roles and delegated scopes in [api-permissions.json](../deploy/entra/api-permissions.json). It is a permission fragment for an administrator-managed registration, not a tenant deployment file. Its role/scope GUIDs are public schema constants, not tenant or customer identifiers. Merge deliberately; do not replace unrelated permissions on an existing application.
3. Keep the scopes admin-consent-only. `Insights.Admin` permits users/groups and approved application identities; `Insights.Publisher` permits users/groups, not arbitrary app-only ingestion.
4. Add the `idtyp` access-token optional claim if using app-only admin automation.
5. On the API **enterprise application**, set **Assignment required? → Yes**. Assign a small admin group to `Insights.Admin`; assign approved contributors to the non-admin `Insights.Publisher` role. Do not make every contributor an admin merely to allow sign-in.

See Microsoft's [app-role guide](https://learn.microsoft.com/entra/identity-platform/howto-add-app-roles-in-apps), [claims validation](https://learn.microsoft.com/entra/identity-platform/claims-validation), and [API role/scope verification](https://learn.microsoft.com/entra/identity-platform/scenario-protected-web-api-verification-scope-app-roles).

## 2. Register the portal and approved OAuth clients

Create a separate single-tenant **SPA/public client** registration for the portal. The server requires its client ID to differ from the API audience.

- Register the exact SPA redirect URI `https://<insights-host>/auth/redirect.html` and the root origin used after redirect sign-out. Request the API's delegated `Insights.Read` scope and grant approved tenant admin consent.
- Do not add a browser client secret. MSAL Browser handles authorization code + PKCE, using session storage. Access tokens are sent to this API in authorization headers, not query strings or stored review documents.
- Serve both the MSAL library and redirect bridge from this service, never a third-party CDN. The bridge is `no-store`, permits same-origin framing, and deliberately has **no Cross-Origin-Opener-Policy header**. Do not override those bridge headers at ingress; other portal pages retain strict isolation. This follows the [MSAL v5 redirect bridge guidance](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/redirect-bridge.md).
- The HTML/CSS sign-in shell is public, but contains no reports. Server-side validation, not a hidden button or decoded browser claim, protects all data routes and review writes.
- Register/authorize separate public clients for the VS Code publisher and MCP clients as needed. The publisher only needs `Context.Publish`; it uses VS Code's built-in Microsoft authentication provider with the configured tenant and client ID. Configure that provider's supported desktop/broker redirect URIs for your qualified VS Code distribution. Do not reuse the SPA redirect URI as a desktop callback.
- Entra dynamic client registration is not supplied by this server. MCP clients must support the statically registered client and requested API scope; see [MCP authorization](admin-mcp.md#production-authorization).

## 3. Configure the service behind HTTPS

Build the [insights Docker image](../apps/insights/Dockerfile). Builds install pinned dependencies from the lockfile; restricted environments can supply an approved registry through the `NPM_REGISTRY` build argument. Do not embed registry credentials or private feed URLs in source or lockfiles.

Set these deployment values through your infrastructure configuration, outside source control:

```dotenv
NODE_ENV=production
INSIGHTS_MODE=production
INSIGHTS_PUBLIC_ORIGIN=https://insights.example.test
INSIGHTS_ENTRA_TENANT_ID=<tenant-guid>
INSIGHTS_ENTRA_AUDIENCE=<api-application-client-id>
INSIGHTS_ENTRA_CLIENT_ID=<portal-spa-client-id>
INSIGHTS_ORGANIZATION_ID=<trusted-collector-organization-id>
INSIGHTS_ORGANIZATION_NAME=<organization-display-label>
INSIGHTS_TELEMETRY_PATH=/data/vscode-telemetry.jsonl
INSIGHTS_REVIEW_PATH=/app/state/reviews.json
INSIGHTS_CONTEXT_PATH=/app/state/windows.json
```

Replace every placeholder. The example hostname is fictional. The collector's organization must match; the client cannot choose it in a registration request. Keep the sanitized input mount read-only and the state mount writable only by the service. Use **one replica/writer** for the file-backed review and window stores, with private persistent storage, backups, and explicit retention. Never mount source repositories, customer databases, or workspace `.copilot-insights` folders into the analytics container.

To read an Azure Monitor workspace instead of a capture file, set `INSIGHTS_LOG_ANALYTICS_WORKSPACE_ID` to the usage workspace ID and `AZURE_CLIENT_ID` to a user-assigned managed identity with `Log Analytics Reader` on that workspace; `INSIGHTS_TELEMETRY_PATH` is then ignored. This source requires the Azure Container Apps managed identity endpoint. The Azure template sets these values.

Terminate TLS at an approved ingress and keep the Node listener private. Preserve the configured public `Host`, restrict accepted origins, and enforce request/rate limits. Public HTTPS and direct access-token validation are both required; `X-MS-CLIENT-PRINCIPAL`, forwarded identity headers, or a successful upstream sign-in are not accepted as an authorization substitute. Health checks can use loopback `/api/health`; it returns only status/mode.

For disposable HTTPS labs, the existing [certificate helper](../scripts/manage-dev-certificate.ps1) can generate a self-signed certificate and explicitly trust it locally. Keep private keys outside source control, do not disable certificate checks, and use approved managed certificates for production. This application expects TLS termination; it does not silently open an insecure public production port or generate/trust certificates at startup.

## 4. Validate or explicitly assign a role

[manage-entra-access.ps1](../scripts/manage-entra-access.ps1) is an **administrator-only** Graph utility, not an employee onboarding script. Its default action is read-only `Test`; assignment requires explicit `-Action Assign` and supports `-WhatIf`/confirmation.

On a controlled admin workstation, install/import `Microsoft.Graph.Authentication`, then connect to the intended tenant with approved Graph permissions. `Application.Read.All` and `Directory.Read.All` support this utility's application, principal-type, and assignment inspection. Add `AppRoleAssignment.ReadWrite.All` **only when assigning**; the signed-in administrator also needs a supported Entra directory role. Do not distribute Graph admin permissions, tokens, or this utility through the employee client package.

```powershell
Connect-MgGraph -TenantId '<tenant-guid>' -Scopes 'Application.Read.All','Directory.Read.All'
./scripts/manage-entra-access.ps1 -TenantId '<tenant-guid>' `
  -ApiApplicationId '<api-application-client-id>' `
  -PrincipalObjectId '<admin-user-or-group-object-id>' -Role Insights.Admin
```

The validator requires the exact tenant, v2 single-tenant API configuration, an enabled compatible app role and scope, **assignment required**, and the exact principal/resource/role assignment. It follows paginated Graph assignment results without accepting arbitrary pagination origins. Failure does not grant access or weaken configuration.

If an authorized administrator intends to create the assignment, reconnect with the additional assignment permission, then run the same command with `-Action Assign` (optionally `-WhatIf` first). The script is idempotent and reads the assignment back. It checks a direct assignment to the supplied user, group, or service principal; it does **not** claim to validate an individual user's nested/effective group membership. Allow for [Graph replication delays](https://learn.microsoft.com/graph/api/serviceprincipal-list-approleassignedto) and obtain a fresh API token after changes.

The result deliberately includes `TokenAndServiceValidated = false`. Seeing a role in Graph is not proof that a particular browser/MCP client receives the right audience, role, and delegated scope. See Microsoft's [assignment API and required permissions](https://learn.microsoft.com/graph/api/serviceprincipal-post-approleassignedto).

## 5. Live acceptance checklist

- Assigned admin: complete portal sign-in, select a project, view a report, and save/reload a review. The same admin can initialize MCP and call its report tools.
- Publisher-only user: register a window successfully; report APIs, UX report loading, and MCP requests return `403`.
- App-only admin: report tools succeed; context registration and human-review writes return `403`. Saving a review requires delegated admin sign-in, the correct origin, and the portal's review token.
- Unassigned user: sign-in/token issuance is refused by assignment policy or the API rejects the token. A token without `Insights.Admin` must never reveal report data.
- Wrong tenant/audience, expired token, tampered signature, ID token, forged proxy identity header, or a prior MCP initialization without current authorization: rejected. Never paste actual tokens into issues or checked-in test fixtures.
- Remove an assignment in the controlled pilot, acquire a fresh token, and repeat the denied cases. Existing valid JWTs can retain roles until expiry; immediate token/role revocation is **not** implemented by a live Graph lookup on every request. Use short appropriate token lifetimes and tenant access controls.
- Repeat native window → project → collector → portal/MCP correlation with approved dummy work, then restore any temporary local settings. The automated JWT tests and mocked Graph tests are not live Entra or native-client evidence.

These checks must be recorded in your tenant before production approval. This implementation's checked-in tests use generated RSA test keys and mocked Graph responses; no real tenant assignment, client consent, or cloud data-plane validation is implied.

## Organization rollout: Intune

The [Intune production plan](intune-deployment.md) owns installation/update/removal of the signed companion and qualified telemetry forwarder, machine-level publisher configuration, managed telemetry policy, pilot assignments, and central rollback. Users choose their current project in the status bar and perform normal sign-in when required; they do not clone the repository, run setup/startup scripts, choose an ingestion endpoint, or manage bearer tokens.

Admin portal/MCP role assignment and publisher enrollment are separate administrative responsibilities. Intune packaging and the forwarder's renewable production token lifecycle remain to be qualified; adding Entra protection to this API does not complete those gates.
