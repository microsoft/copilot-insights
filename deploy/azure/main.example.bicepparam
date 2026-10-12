using './main.bicep'

// Example values only. Copy to an untracked file and replace the placeholders.
param namePrefix = 'ciexample'
param organizationId = 'example-org'
param ingestionAudience = '00000000-0000-0000-0000-000000000000'
param containerImage = 'copilot-insights:0.1.0'
param deployCollector = false
param deployInsights = false
param organizationName = 'Example organization'
param insightsApiClientId = ''
param insightsPortalClientId = ''
param clientVirtualNetworkIds = []
param allowedClientCidrs = []
param registryAllowedIpRanges = []
