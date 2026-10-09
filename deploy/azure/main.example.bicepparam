using './main.bicep'

// Example values only. Copy to an untracked file and replace the placeholders.
param namePrefix = 'ciexample'
param organizationId = 'example-org'
param ingestionAudience = '00000000-0000-0000-0000-000000000000'
param deployCollector = false
param collectorImage = 'copilot-insights-collector:0.1.0'
param deployInsights = false
param insightsImage = 'copilot-insights-review:0.1.0'
param organizationName = 'Example organization'
param insightsApiClientId = ''
param insightsPortalClientId = ''
param clientVirtualNetworkIds = []
param allowedClientCidrs = []
param registryAllowedIpRanges = []
