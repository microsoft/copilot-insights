#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..' 'manage-entra-access.ps1'
$permissions = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..' '..' 'deploy' 'entra' 'api-permissions.json') | ConvertFrom-Json
$tenant = '11111111-1111-4111-8111-111111111111'
$applicationId = '22222222-2222-4222-8222-222222222222'
$principalId = '33333333-3333-4333-8333-333333333333'
$resourceId = '44444444-4444-4444-8444-444444444444'
$failures = 0
$testState = @{ Assignments = @(); AssignmentRequired = $true; Posts = 0; WrongTenant = $false }

function Get-MgContext { [pscustomobject]@{ TenantId = $(if ($testState.WrongTenant) { $resourceId } else { $tenant }) } }
function Invoke-MgGraphRequest {
    param($Method, $Uri, $Body, $ContentType, $OutputType)
    if ($Method -eq 'POST') {
        $testState.Posts++
        $testState.Assignments += ($Body | ConvertFrom-Json)
        return [pscustomobject]@{}
    }
    if ($Uri -match '/applications\(') { return [pscustomobject]@{ appId = $applicationId; api = $permissions.api; signInAudience = $permissions.signInAudience; identifierUris = @("api://$applicationId") } }
    if ($Uri -match '/servicePrincipals\(') { return [pscustomobject]@{ id = $resourceId; appRoles = $permissions.appRoles; appRoleAssignmentRequired = $testState.AssignmentRequired } }
    if ($Uri -match '/directoryObjects/') { return [pscustomobject]@{ '@odata.type' = '#microsoft.graph.user' } }
    if ($Uri -match '/appRoleAssignedTo') { return [pscustomobject]@{ value = $testState.Assignments } }
    throw 'Unexpected Graph request.'
}
function Test-Case([string] $Title, [scriptblock] $Body) {
    try { & $Body; Write-Host "PASS  $Title" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "FAIL  ${Title}: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-That([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }
function Assert-Rejected([scriptblock] $Body, [string] $Pattern) {
    $message = $null
    try { & $Body | Out-Null } catch { $message = $_.Exception.Message }
    Assert-That ($message -match $Pattern) "Expected rejection matching $Pattern; got '$message'."
}
$arguments = @{ TenantId = $tenant; ApiApplicationId = $applicationId; PrincipalObjectId = $principalId }

Test-Case 'Unassigned principals fail validation without granting themselves access' {
    Assert-Rejected { & $scriptPath @arguments } 'does not have'
    Assert-That ($testState.Posts -eq 0) 'A Test invocation changed permissions.'
}
Test-Case 'WhatIf never writes an app-role assignment' {
    & $scriptPath @arguments -Action Assign -WhatIf
    Assert-That ($testState.Posts -eq 0) 'WhatIf changed permissions.'
}
Test-Case 'Explicit assignment is verified by reading the resource service principal again' {
    $result = & $scriptPath @arguments -Action Assign -Confirm:$false
    Assert-That ($result.AssignmentVerified -and -not $result.TokenAndServiceValidated) 'Role proof was confused with an end-to-end token test.'
    Assert-That ($testState.Posts -eq 1) 'Expected exactly one explicit assignment.'
    & $scriptPath @arguments -Action Assign -Confirm:$false | Out-Null
    Assert-That ($testState.Posts -eq 1) 'Idempotent assignment created a duplicate.'
}
Test-Case 'An admin assignment never satisfies the publisher role' {
    Assert-Rejected { & $scriptPath @arguments -Role Insights.Publisher } 'does not have'
}
Test-Case 'Tenant mismatch and optional assignment fail closed' {
    $testState.WrongTenant = $true
    Assert-Rejected { & $scriptPath @arguments } 'explicitly selected tenant'
    $testState.WrongTenant = $false
    $testState.AssignmentRequired = $false
    Assert-Rejected { & $scriptPath @arguments } 'Assignment required'
    $testState.AssignmentRequired = $true
}
if ($failures) { throw "$failures Entra role-assignment test(s) failed." }
Write-Host 'All Entra role-assignment tests passed. Graph responses were mocked; no tenant permissions changed.' -ForegroundColor Green
