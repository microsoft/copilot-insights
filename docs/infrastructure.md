# Infrastructure

Status: reference deployment. The template in [deploy/azure](../deploy/azure) compiles and lints cleanly, but the maintainers have not yet deployed it in a subscription. Validate it in a non-production subscription before onboarding users.

## Topology

Every data path between the client network, the collector, the registry, and telemetry storage uses private IP addresses. The collector has no public ingress.

```mermaid
flowchart LR
    subgraph Client["Client network (peered)"]
        Dev["Dev Box: VS Code + Copilot"]
    end
    subgraph VNet["Collector virtual network"]
        subgraph Env["Internal Container Apps environment"]
            Col["Collector: token validation, privacy pipeline"]
        end
        PEacr["Private endpoint: registry"]
        PEmon["Private endpoint: Azure Monitor"]
    end
    Dev -->|"OTLP/HTTPS + Entra token"| Col
    Col -->|"Image pull"| PEacr --> ACR["Container Registry, public access off"]
    Col -->|"Managed identity"| PEmon --> AI["Application Insights, public ingestion off"]
    AI --> LAW["Log Analytics: usage"]
    Env -.->|"Platform logs"| OPS["Log Analytics: operations"]
    Col -.->|"Token keys and managed identity tokens"| Entra["Microsoft Entra ID"]
    Dev -->|"Model traffic, unchanged"| Copilot["GitHub Copilot"]
```

## Resources

| Resource | Purpose | Private connectivity |
|---|---|---|
| Virtual network | Container Apps subnet (delegated) and private endpoint subnet | Peer client networks to it |
| Container Apps environment | Hosts the collector; workload profiles, Consumption profile | Internal: reachable only from connected networks through a static private IP |
| Container app | Collector image with the `azure` profile; ingress on port 4318, health on 13133 | VNet-scoped ingress, optional client CIDR allow-list |
| Container Registry (Premium) | Stores the collector image | Private endpoint; public access disabled unless push ranges are allowed |
| User-assigned managed identity | Pulls the image and authenticates exports | No secrets in configuration |
| Application Insights | Usage ingestion; local authentication disabled | Public ingestion disabled; reached through the private endpoint |
| Log Analytics (usage) | Durable query store for collected telemetry | Public ingestion disabled; query access configurable |
| Log Analytics (operations) | Container Apps platform and collector logs | Kept separate from usage telemetry |
| Azure Monitor Private Link Scope | Private ingestion for the workspaces and Application Insights | Open access mode, so other monitor resources reachable from the network keep working |
| Private DNS zones | Registry, Azure Monitor, and Container Apps environment names | See [DNS](#dns) |

Role assignments grant the managed identity `AcrPull` on the registry and `Monitoring Metrics Publisher` on Application Insights.

## Network paths

| Path | Private | Notes |
|---|---|---|
| Client to collector | Yes | Internal environment static IP, resolved through private DNS |
| Collector image pull | Yes | Registry private endpoint |
| Collector to Application Insights | Yes | Azure Monitor private endpoint; the resources reject public ingestion |
| Collector to Microsoft Entra ID | No | OIDC discovery, signing keys, and managed identity tokens use Entra ID endpoints, which private endpoints do not cover |
| Platform logs to the operations workspace | Platform-managed | Sent by Container Apps |
| Queries from the portal or Workbooks | Configurable | `queryPublicNetworkAccess = 'Disabled'` restricts queries to connected networks |
| Image push | Configurable | From a connected network, or from ranges temporarily listed in `registryAllowedIpRanges` |

The template does not force-tunnel egress. To route outbound traffic through a firewall, add a route table and follow the Container Apps egress requirements, keeping Entra ID reachable.

## DNS

- Registry and Azure Monitor zones link only to the collector network. Linking Azure Monitor private zones to another network changes how every Azure Monitor resource resolves from that network, so do not link them to client networks.
- The Container Apps environment zone links to the collector network and to every network in `clientVirtualNetworkIds`, so clients resolve the collector to its private IP.
- With central DNS (for example, a hub DNS Private Resolver), add equivalent records or forwarding rules there and leave `clientVirtualNetworkIds` empty.

## Prerequisites

- A resource group, and permission to create resources and role assignments in it (for example, Contributor plus Role Based Access Control Administrator).
- A client network that does not overlap `vnetAddressPrefix`, peered with the collector network after the first deployment. A Dev Box network connection that uses this client network gives Dev Boxes access.
- Azure CLI with Bicep, PowerShell 7.2 or later, and Docker (or another OCI image builder) on a machine that can reach the registry.
- An Entra ID tenant administrator to register the ingestion API.

## Register the ingestion API

The collector accepts only Entra ID v2 access tokens whose audience is this application. Run as a tenant administrator:

```powershell
$app = az ad app create --display-name 'copilot-insights-ingestion' --sign-in-audience AzureADMyOrg --query '{appId:appId,id:id}' -o json | ConvertFrom-Json
az ad app update --id $app.appId --identifier-uris "api://$($app.appId)"

$scope = @{
    id = [guid]::NewGuid().ToString(); value = 'Telemetry.Write'; type = 'User'; isEnabled = $true
    adminConsentDisplayName = 'Send Copilot telemetry'; adminConsentDescription = 'Allows the signed-in user to send telemetry to Copilot Insights.'
    userConsentDisplayName = 'Send Copilot telemetry'; userConsentDescription = 'Allows sending telemetry to Copilot Insights on your behalf.'
}
$body = Join-Path ([IO.Path]::GetTempPath()) 'copilot-insights-api.json'
@{ api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @($scope) } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $body
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$($app.id)" --headers 'Content-Type=application/json' --body "@$body"

az ad sp create --id $app.appId
az ad sp update --id $app.appId --set appRoleAssignmentRequired=true
$app.appId
```

- Use the printed application ID as `ingestionAudience`.
- `appRoleAssignmentRequired` means only users and groups assigned to the enterprise application can obtain tokens. Assign pilot participants under **Enterprise applications > copilot-insights-ingestion > Users and groups**.
- Token issuance authenticates the uploader. It does not prove that uploaded telemetry is accurate; the collector still enforces the data contract.

To verify the deployment with Azure CLI tokens, an administrator can pre-authorize the Azure CLI client (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) for the `Telemetry.Write` scope. Remove that authorization after testing if your organization does not allow it permanently.

## Deploy

Deploy in two phases, because the container app needs an image in the private registry.

1. Copy [main.example.bicepparam](../deploy/azure/main.example.bicepparam) to `deploy/azure/main.bicepparam` (ignored by Git) and set `namePrefix`, `organizationId`, `ingestionAudience`, and `clientVirtualNetworkIds`. Keep `deployCollector = false`.

2. Deploy the network, registry, and storage:

   ```powershell
   az group create --name <resource-group> --location <region>
   az deployment group create --resource-group <resource-group> --name copilot-insights --parameters deploy/azure/main.bicepparam
   ```

3. Peer the client network with the collector network (`vnetId` output). Peering is outside this template because it usually crosses subscriptions or ownership boundaries.

4. Build and push the image from a machine that can reach the registry: a host in a connected network, or one whose public range you temporarily added to `registryAllowedIpRanges` and redeployed.

   ```powershell
   $outputs = az deployment group show --resource-group <resource-group> --name copilot-insights --query properties.outputs -o json | ConvertFrom-Json
   $image = "$($outputs.registryLoginServer.value)/copilot-insights-collector:0.1.0"
   docker build --tag $image collector
   az acr login --name $outputs.registryName.value
   docker push $image
   ```

5. Set `deployCollector = true`, clear any `registryAllowedIpRanges`, and run the deployment command again.

## Verify

From a machine in a connected network:

```powershell
$fqdn = ([Uri]$outputs.collectorEndpoint.value).Host
Resolve-DnsName $fqdn   # Expect the environmentStaticIp output, a private address
./scripts/verify.ps1 -Endpoint $outputs.collectorEndpoint.value -AccessTokenScope "api://<ingestion-app-id>/Telemetry.Write"
```

The script sends synthetic telemetry with canary values and prints two queries. Run them in the usage workspace after ingestion delay: the first must return the three approved operations, and the second must return zero rows. Also confirm:

- A request without a token receives HTTP 401.
- The collector endpoint does not resolve or respond from outside connected networks.
- `ContainerAppConsoleLogs_CL` in the operations workspace shows no repeated export or authentication errors.

## Connect a pilot client

The native Copilot exporter sends no credentials unless configured with a header, and the authentication helper in the [architecture](architecture.md) is not implemented yet. Until it is:

- Use the local quick start for client-side trials.
- For a time-boxed lab test with a synthetic workspace only, a short-lived token can be supplied through `OTEL_EXPORTER_OTLP_HEADERS` in the editor's launch environment. Tokens expire within about an hour, and agent tool subprocesses can inherit the variable, so do not use this with real projects.

## Operations

- **Logs:** collector output is in `ContainerAppConsoleLogs_CL` and platform events in `ContainerAppSystemLogs_CL` of the operations workspace.
- **Delivery:** the export queue is in memory. A replica restart can lose queued batches; add a persistent queue before relying on the data for anything that needs completeness.
- **Updates:** build and push a new tag, update `collectorImage`, and redeploy. Run the local verification against the new image first.
- **Cost drivers:** the Premium registry and private endpoints have standing charges; Container Apps and Log Analytics charges scale with usage and retention.
- **Removal:** delete the resource group, then the app registration and any peering on the client side.

## Hardening backlog

- Build a minimal collector distribution with only the required components instead of the contrib image.
- Route egress through a firewall, and disable public query access where operators work from connected networks.
- Use `PrivateOnly` Azure Monitor access mode on dedicated networks.
- Enable zone redundancy, and add a persistent sending queue.
- Automate the image build, signing, and template validation in CI.
