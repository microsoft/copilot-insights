#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..' '..'))
$template = Get-Content -Raw -LiteralPath (Join-Path $root 'deploy/azure/azuredeploy.json') | ConvertFrom-Json -Depth 100
$failures = 0

function Test-Case([string] $title, [scriptblock] $body) {
    try { & $body; Write-Host "PASS  $title" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "FAIL  ${title}: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-That([bool] $condition, [string] $message) { if (-not $condition) { throw $message } }
function Get-Resource([string] $type) {
    $resources = @($template.resources | Where-Object { $_.type -eq $type })
    Assert-That ($resources.Count -eq 1) "Expected exactly one $type resource."
    return $resources[0]
}
function Get-App([string] $name) {
    $apps = @($template.resources | Where-Object { $_.type -eq 'Microsoft.App/containerApps' -and $_.name -eq "[variables('${name}AppName')]" })
    Assert-That ($apps.Count -eq 1) "Expected exactly one $name container app."
    return $apps[0]
}

Test-Case 'The portal artifact is standalone ARM JSON with embedded DNS modules' {
    Assert-That ($template.'$schema' -match '/deploymentTemplate\.json#$') 'Unexpected ARM template schema.'
    $modules = @($template.resources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' })
    Assert-That ($modules.Count -eq 2) 'Expected default-domain and optional custom-domain DNS modules.'
    foreach ($module in $modules) {
        Assert-That ($null -ne $module.properties.template) 'A DNS module is not embedded in the portal artifact.'
        Assert-That (-not $module.properties.PSObject.Properties['templateLink']) 'The template unexpectedly downloads a nested artifact.'
    }
}
Test-Case 'Infrastructure deployment does not accidentally activate an unpublished collector image' {
    Assert-That ($template.parameters.deployCollector.defaultValue -eq $false) 'The first deployment must be infrastructure-only.'
    $collector = Get-App 'collector'
    Assert-That ($collector.condition -eq "[parameters('deployCollector')]") 'Collector creation is not explicitly gated.'
    Assert-That ($template.outputs.collectorDeployed.value -eq "[parameters('deployCollector')]") 'Deployment status is not exposed accurately.'
}
Test-Case 'The insights portal is gated, private, Entra-protected, and reads Log Analytics with its own identity' {
    Assert-That ($template.parameters.deployInsights.defaultValue -eq $false) 'The first deployment must not start the portal.'
    $insights = Get-App 'insights'
    Assert-That ($insights.condition -eq "[parameters('deployInsights')]") 'Portal creation is not explicitly gated.'
    Assert-That ($template.outputs.insightsDeployed.value -eq "[parameters('deployInsights')]") 'Portal status is not exposed accurately.'
    Assert-That ($insights.properties.configuration.ingress.allowInsecure -eq $false) 'Portal ingress must not accept cleartext.'
    Assert-That ($insights.properties.template.scale.maxReplicas -eq 1) 'File-backed review and window stores need a single writer.'
    $environment = @{}
    foreach ($entry in $insights.properties.template.containers[0].env) { $environment[$entry.name] = $entry.value }
    Assert-That ($environment.INSIGHTS_MODE -eq 'production') 'The portal must run in Entra production mode.'
    Assert-That ($environment.INSIGHTS_LOG_ANALYTICS_WORKSPACE_ID -match 'usage-law') 'The portal must query the usage workspace.'
    Assert-That ($environment.AZURE_CLIENT_ID -match 'insights-id') 'The portal must use its own managed identity.'
    $roles = @($template.resources | Where-Object { $_.type -eq 'Microsoft.Authorization/roleAssignments' -and $_.properties.principalId -match 'insights-id' })
    Assert-That ($roles.Count -eq 2) 'The portal identity needs only AcrPull and Log Analytics Reader.'
    $storage = Get-Resource 'Microsoft.Storage/storageAccounts'
    Assert-That ($storage.condition -eq "[parameters('deployInsights')]") 'State storage is not gated with the portal.'
    Assert-That ($storage.properties.publicNetworkAccess -eq 'Disabled') 'State storage is public.'
    Assert-That ($storage.properties.allowBlobPublicAccess -eq $false) 'State storage allows public blobs.'
}
Test-Case 'Ingestion remains private and HTTPS-only' {
    $environment = Get-Resource 'Microsoft.App/managedEnvironments'
    $collector = Get-App 'collector'
    Assert-That ($environment.properties.vnetConfiguration.internal -eq $true) 'Container Apps environment is not internal.'
    Assert-That ($collector.properties.configuration.ingress.allowInsecure -eq $false) 'HTTP ingress must not accept cleartext.'
    Assert-That ($collector.properties.configuration.ingress.targetPort -eq 4318) 'Unexpected OTLP ingress port.'
}
Test-Case 'Registry defaults deny public access and disable administrator credentials' {
    $registry = Get-Resource 'Microsoft.ContainerRegistry/registries'
    Assert-That ($registry.properties.adminUserEnabled -eq $false) 'Registry administrator credentials are enabled.'
    Assert-That ($registry.properties.networkRuleSet.defaultAction -eq 'Deny') 'Registry default action is not deny.'
    Assert-That ($template.parameters.registryAllowedIpRanges.defaultValue.Count -eq 0) 'Public image-push ranges must be opt-in.'
    Assert-That ($registry.properties.publicNetworkAccess -eq "[if(empty(parameters('registryAllowedIpRanges')), 'Disabled', 'Enabled')]") 'Registry networking no longer fails closed.'
}
Test-Case 'Usage storage rejects public ingestion and local authentication' {
    $insights = Get-Resource 'Microsoft.Insights/components'
    Assert-That ($insights.properties.publicNetworkAccessForIngestion -eq 'Disabled') 'Usage ingestion is public.'
    Assert-That ($insights.properties.DisableLocalAuth -eq $true) 'Application Insights local authentication is enabled.'
}
Test-Case 'Both PFX fields are secure parameters and never become outputs' {
    foreach ($name in @('tlsCertificateData', 'tlsCertificatePassword')) {
        Assert-That ($template.parameters.$name.type -eq 'secureString') "$name is not a secure parameter."
        Assert-That ($template.parameters.$name.defaultValue -eq '') "$name has an embedded value."
        Assert-That (($template.outputs | ConvertTo-Json -Depth 20) -notmatch $name) "$name appears in deployment outputs."
    }
    $certificate = Get-Resource 'Microsoft.App/managedEnvironments/certificates'
    Assert-That ($certificate.properties.value -eq "[parameters('tlsCertificateData')]") 'Unexpected certificate data source.'
    Assert-That ($certificate.properties.password -eq "[parameters('tlsCertificatePassword')]") 'Unexpected certificate password source.'
}
Test-Case 'The README deployment button targets the compiled public template, without credentials' {
    $readme = Get-Content -Raw -LiteralPath (Join-Path $root 'README.md')
    $match = [regex]::Match($readme, 'https://portal\.azure\.com/#create/Microsoft\.Template/uri/([^\s)]+)')
    Assert-That $match.Success 'The Deploy to Azure button is missing.'
    $target = [Uri]::UnescapeDataString($match.Groups[1].Value)
    Assert-That ($target -eq 'https://raw.githubusercontent.com/microsoft/copilot-insights/main/deploy/azure/azuredeploy.json') 'Unexpected template target or credentials in the link.'
}

if ($failures) { throw "$failures Azure template test(s) failed." }
Write-Host 'All Azure template contract tests passed.' -ForegroundColor Green
