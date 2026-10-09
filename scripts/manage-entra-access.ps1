#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][guid] $TenantId,
    [Parameter(Mandatory)][guid] $ApiApplicationId,
    [Parameter(Mandatory)][guid] $PrincipalObjectId,
    [ValidateSet('Insights.Admin', 'Insights.Publisher')][string] $Role = 'Insights.Admin',
    [ValidateSet('Test', 'Assign')][string] $Action = 'Test'
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command Invoke-MgGraphRequest -ErrorAction SilentlyContinue)) {
    throw 'Install Microsoft.Graph.Authentication and connect an approved administrator with Connect-MgGraph before running this administrative script.'
}
$graphContext = Get-MgContext
if (-not $graphContext -or $graphContext.TenantId -ne $TenantId.ToString()) {
    throw 'Connect-MgGraph must be signed into the explicitly selected tenant. No role assignments were changed.'
}
$graphRoot = 'https://graph.microsoft.com/v1.0'

function Read-GraphCollection([string] $Uri) {
    $entries = @()
    $pages = 0
    while ($Uri) {
        if (-not $Uri.StartsWith("$graphRoot/", [StringComparison]::Ordinal) -or ++$pages -gt 1000) {
            throw 'An unsupported Graph pagination response was rejected.'
        }
        $page = Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputType PSObject
        $entries += @($page.value)
        $Uri = $page.'@odata.nextLink'
    }
    return $entries
}

$application = Invoke-MgGraphRequest -Method GET -Uri "$graphRoot/applications(appId='$ApiApplicationId')?`$select=id,appId,api,signInAudience,identifierUris" -OutputType PSObject
$resource = Invoke-MgGraphRequest -Method GET -Uri "$graphRoot/servicePrincipals(appId='$ApiApplicationId')?`$select=id,appId,appRoles,appRoleAssignmentRequired" -OutputType PSObject
$principal = Invoke-MgGraphRequest -Method GET -Uri "$graphRoot/directoryObjects/$PrincipalObjectId" -OutputType PSObject
$memberType = switch ($principal.'@odata.type') {
    '#microsoft.graph.user' { 'User' }
    '#microsoft.graph.group' { 'User' }
    '#microsoft.graph.servicePrincipal' { 'Application' }
    default { throw 'Only a user, security group, or service principal can receive this app role.' }
}
$scope = if ($Role -eq 'Insights.Admin') { 'Insights.Read' } else { 'Context.Publish' }
if ($application.signInAudience -ne 'AzureADMyOrg' -or $application.api.requestedAccessTokenVersion -ne 2 -or
    @($application.identifierUris) -notcontains "api://$ApiApplicationId") {
    throw 'The API must be single-tenant, issue v2 access tokens, and expose its api://<application-id> identifier URI.'
}
if ($resource.appRoleAssignmentRequired -ne $true) {
    throw 'Set Assignment required to Yes on the Insights API enterprise application before granting access.'
}
$permission = @($application.api.oauth2PermissionScopes | Where-Object { $_.value -ceq $scope -and $_.isEnabled })
$appRole = @($resource.appRoles | Where-Object { $_.value -ceq $Role -and $_.isEnabled -and $_.allowedMemberTypes -contains $memberType })
if ($permission.Count -ne 1 -or $appRole.Count -ne 1) {
    throw 'The enabled API permission and compatible app role must each exist exactly once. Azure subscription RBAC is not an app-role assignment.'
}
$assignmentUri = "$graphRoot/servicePrincipals/$($resource.id)/appRoleAssignedTo"
$assignments = @(Read-GraphCollection $assignmentUri | Where-Object { $_.principalId -eq $PrincipalObjectId.ToString() -and $_.resourceId -eq $resource.id -and $_.appRoleId -eq $appRole[0].id })
if (-not $assignments.Count -and $Action -eq 'Assign') {
    if (-not $PSCmdlet.ShouldProcess($PrincipalObjectId.ToString(), "Assign $Role on Insights API $ApiApplicationId in tenant $TenantId")) { return }
    $body = @{ principalId = $PrincipalObjectId.ToString(); resourceId = $resource.id; appRoleId = $appRole[0].id } | ConvertTo-Json -Compress
    Invoke-MgGraphRequest -Method POST -Uri $assignmentUri -Body $body -ContentType 'application/json' -OutputType PSObject | Out-Null
    $assignments = @(Read-GraphCollection $assignmentUri | Where-Object { $_.principalId -eq $PrincipalObjectId.ToString() -and $_.resourceId -eq $resource.id -and $_.appRoleId -eq $appRole[0].id })
}
if (-not $assignments.Count) {
    throw 'The exact principal does not have the requested app role. No admin access is established. Recent assignments can require replication time; rerun Test, then acquire a fresh API access token.'
}
[pscustomobject]@{
    TenantId = $TenantId.ToString()
    ApiApplicationId = $ApiApplicationId.ToString()
    PrincipalObjectId = $PrincipalObjectId.ToString()
    Role = $Role
    AssignmentRequired = $true
    AssignmentVerified = $true
    TokenAndServiceValidated = $false
}
