// Private copilot-insights deployment: internal Container Apps ingestion, private image pulls, and private
// Azure Monitor ingestion. See docs/infrastructure.md for prerequisites and the two-phase deployment.
targetScope = 'resourceGroup'

@description('Region for all regional resources.')
param location string = resourceGroup().location

@description('Lowercase letters and digits only; prefixes resource names.')
@minLength(2)
@maxLength(10)
param namePrefix string = 'ci'

@description('Organization label stamped on every record by the collector. Client-supplied values are overwritten.')
param organizationId string

@description('Application (client) ID of the Entra ID app registration that represents the ingestion API.')
param ingestionAudience string

@description('Tenant that issues ingestion tokens.')
param ingestionTenantId string = tenant().tenantId

@description('Set to false for the first deployment, push the image, then redeploy with true.')
param deployCollector bool = false

@description('Collector image as repository:tag in the registry this template creates.')
param collectorImage string = 'copilot-insights-collector:0.1.0'

@description('Optional private DNS hostname for the collector. Supply a matching PFX and password when set.')
param collectorHostname string = ''

@secure()
@description('Base64-encoded PFX for collectorHostname. Supply through a private parameter file, never source control.')
param tlsCertificateData string = ''

@secure()
@description('Password of the PFX supplied in tlsCertificateData.')
param tlsCertificatePassword string = ''

@description('Address space of the dedicated virtual network.')
param vnetAddressPrefix string = '10.60.0.0/22'

@description('Container Apps infrastructure subnet; /27 or larger.')
param environmentSubnetPrefix string = '10.60.0.0/24'

@description('Subnet for private endpoints.')
param privateEndpointSubnetPrefix string = '10.60.1.0/24'

@description('Peered client networks (for example, the Dev Box network) that must resolve the collector endpoint.')
param clientVirtualNetworkIds array = []

@description('Client CIDR ranges allowed to call the collector. Empty allows any address in connected networks.')
param allowedClientCidrs array = []

@description('Temporary public IP ranges allowed to push images. Empty keeps the registry private-only.')
param registryAllowedIpRanges array = []

@description('Whether Log Analytics and Application Insights accept queries from public networks.')
@allowed(['Enabled', 'Disabled'])
param queryPublicNetworkAccess string = 'Enabled'

@description('Retention for collected usage telemetry, in days.')
@minValue(30)
@maxValue(730)
param usageRetentionInDays int = 30

@minValue(1)
param minReplicas int = 1

@minValue(1)
param maxReplicas int = 3

var prefix = toLower(namePrefix)
var vnetName = '${prefix}-vnet'
var environmentSubnetName = 'snet-container-apps'
var privateEndpointSubnetName = 'snet-private-endpoints'
var collectorAppName = '${prefix}-collector'
var registryName = '${prefix}cr${uniqueString(resourceGroup().id)}'

var monitorDnsZoneNames = [
  'privatelink.monitor.azure.com'
  'privatelink.oms.opinsights.azure.com'
  'privatelink.ods.opinsights.azure.com'
  'privatelink.agentsvc.azure-automation.net'
  'privatelink.blob.${environment().suffixes.storage}'
]
var registryDnsZoneName = 'privatelink${environment().suffixes.acrLoginServer}'
var privateDnsZoneNames = concat(monitorDnsZoneNames, [registryDnsZoneName])

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb'

// ---------------------------------------------------------------- network

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: environmentSubnetName
        properties: {
          addressPrefix: environmentSubnetPrefix
          delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: privateEndpointSubnetName
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

var environmentSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, environmentSubnetName)
var privateEndpointSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, privateEndpointSubnetName)

// Linked to the collector network only: Azure Monitor private DNS changes resolution for every monitor resource in a linked network.
resource privateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in privateDnsZoneNames: {
  name: zone
  location: 'global'
}]

resource privateDnsZoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in privateDnsZoneNames: {
  parent: privateDnsZones[i]
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

// ---------------------------------------------------------------- telemetry storage

resource usageWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-usage-law'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: usageRetentionInDays
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: queryPublicNetworkAccess
    features: { disableLocalAuth: true }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-appi'
  location: location
  kind: 'other'
  properties: {
    Application_Type: 'other'
    WorkspaceResourceId: usageWorkspace.id
    IngestionMode: 'LogAnalytics'
    DisableLocalAuth: true
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: queryPublicNetworkAccess
  }
}

// Collector and platform health; kept separate from collected usage telemetry.
resource operationsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-ops-law'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource monitorScope 'Microsoft.Insights/privateLinkScopes@2021-07-01-preview' = {
  name: '${prefix}-ampls'
  location: 'global'
  properties: {
    // Open keeps other monitor resources reachable from this network; ours reject public ingestion themselves.
    accessModeSettings: {
      ingestionAccessMode: 'Open'
      queryAccessMode: 'Open'
    }
  }
}

resource scopedUsageWorkspace 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: monitorScope
  name: 'usage-workspace'
  properties: { linkedResourceId: usageWorkspace.id }
}

resource scopedAppInsights 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: monitorScope
  name: 'app-insights'
  properties: { linkedResourceId: appInsights.id }
}

resource scopedOperationsWorkspace 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: monitorScope
  name: 'operations-workspace'
  properties: { linkedResourceId: operationsWorkspace.id }
}

resource monitorPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-ampls-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'azure-monitor'
        properties: {
          privateLinkServiceId: monitorScope.id
          groupIds: ['azuremonitor']
        }
      }
    ]
  }
  // Workspace-specific DNS records are created for the resources scoped when the endpoint is created.
  dependsOn: [scopedUsageWorkspace, scopedAppInsights, scopedOperationsWorkspace]
}

resource monitorDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: monitorPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [for (zone, i) in monitorDnsZoneNames: {
      name: replace(zone, '.', '-')
      properties: { privateDnsZoneId: privateDnsZones[i].id }
    }]
  }
}

// ---------------------------------------------------------------- registry

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Premium' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: empty(registryAllowedIpRanges) ? 'Disabled' : 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
    networkRuleSet: {
      defaultAction: 'Deny'
      ipRules: [for range in registryAllowedIpRanges: { action: 'Allow', value: range }]
    }
  }
}

resource registryPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-acr-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'registry'
        properties: {
          privateLinkServiceId: registry.id
          groupIds: ['registry']
        }
      }
    ]
  }
}

resource registryDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: registryPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: replace(registryDnsZoneName, '.', '-')
        properties: { privateDnsZoneId: privateDnsZones[length(monitorDnsZoneNames)].id }
      }
    ]
  }
}

// ---------------------------------------------------------------- identity

resource collectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-collector-id'
  location: location
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, collectorIdentity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource telemetryPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, collectorIdentity.id, monitoringMetricsPublisherRoleId)
  scope: appInsights
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------- Container Apps

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-aca-env'
  location: location
  properties: {
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: environmentSubnetId
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: operationsWorkspace.properties.customerId
        sharedKey: operationsWorkspace.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

module environmentDns 'modules/environment-dns.bicep' = {
  name: 'collector-environment-dns'
  params: {
    zoneName: containerAppsEnvironment.properties.defaultDomain
    staticIp: containerAppsEnvironment.properties.staticIp
    virtualNetworkIds: concat([vnet.id], clientVirtualNetworkIds)
  }
}

resource collectorCertificate 'Microsoft.App/managedEnvironments/certificates@2024-03-01' = if (!empty(collectorHostname)) {
  parent: containerAppsEnvironment
  name: 'collector-tls'
  location: location
  properties: {
    value: tlsCertificateData
    password: tlsCertificatePassword
  }
}

module collectorDns 'modules/environment-dns.bicep' = if (!empty(collectorHostname)) {
  name: 'collector-custom-dns'
  params: {
    zoneName: collectorHostname
    staticIp: containerAppsEnvironment.properties.staticIp
    virtualNetworkIds: concat([vnet.id], clientVirtualNetworkIds)
  }
}

resource collector 'Microsoft.App/containerApps@2024-03-01' = if (deployCollector) {
  name: collectorAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${collectorIdentity.id}': {} }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // In an internal environment, external ingress means reachable from connected networks; it is never public.
        external: true
        targetPort: 4318
        transport: 'http'
        allowInsecure: false
        customDomains: empty(collectorHostname) ? [] : [
          {
            name: collectorHostname
            bindingType: 'SniEnabled'
            certificateId: collectorCertificate!.id
          }
        ]
        ipSecurityRestrictions: [for (cidr, i) in allowedClientCidrs: {
          name: 'client-${i}'
          action: 'Allow'
          ipAddressRange: cidr
        }]
      }
      registries: [{ server: registry.properties.loginServer, identity: collectorIdentity.id }]
    }
    template: {
      containers: [
        {
          name: 'collector'
          image: '${registry.properties.loginServer}/${collectorImage}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'CI_ORGANIZATION_ID', value: organizationId }
            { name: 'CI_OIDC_ISSUER_URL', value: '${environment().authentication.loginEndpoint}${ingestionTenantId}/v2.0' }
            { name: 'CI_OIDC_AUDIENCE', value: ingestionAudience }
            { name: 'AZURE_CLIENT_ID', value: collectorIdentity.properties.clientId }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/', port: 13133 }, periodSeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/', port: 13133 }, periodSeconds: 5 }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '100' } } }]
      }
    }
  }
  dependsOn: [registryPull, telemetryPublisher, registryDnsZoneGroup, monitorDnsZoneGroup, privateDnsZoneLinks, environmentDns]
}

output collectorEndpoint string = empty(collectorHostname)
  ? 'https://${collectorAppName}.${containerAppsEnvironment.properties.defaultDomain}'
  : 'https://${collectorHostname}'
output collectorDeployed bool = deployCollector
output containerAppsEnvironmentName string = containerAppsEnvironment.name
output environmentStaticIp string = containerAppsEnvironment.properties.staticIp
output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
output usageWorkspaceId string = usageWorkspace.properties.customerId
output vnetId string = vnet.id
