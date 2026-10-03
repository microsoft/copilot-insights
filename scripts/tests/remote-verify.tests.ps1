#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$verifyScript = Join-Path $PSScriptRoot '..' 'verify.ps1'
$tenantId = '11111111-1111-4111-8111-111111111111'
$failures = 0
$tests = 0

function Test-Case([string] $name, [scriptblock] $body) {
    $script:tests++
    try { & $body; Write-Host "PASS  $name" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "FAIL  ${name}: $($_.Exception.Message)" -ForegroundColor Red }
}

function Assert-That([bool] $condition, [string] $message) { if (-not $condition) { throw $message } }

function Invoke-MockedRemote([hashtable] $Overrides = @{}, [hashtable] $Behavior = @{}) {
    $context = [pscustomobject]@{
        CliCalls = 0
        CliArguments = @()
        CliExitCode = 0
        TokenResult = (@{ accessToken = 'synthetic-test-token'; tenant = $tenantId } | ConvertTo-Json -Compress)
        StatusCode = 200
        Requests = [Collections.Generic.List[object]]::new()
        Error = $null
    }
    foreach ($entry in $Behavior.GetEnumerator()) { $context.($entry.Key) = $entry.Value }
    function az {
        $context.CliCalls++
        $context.CliArguments = @($args)
        $global:LASTEXITCODE = $context.CliExitCode
        $context.TokenResult
    }
    function Invoke-WebRequest {
        param($Method, $Uri, $ContentType, $Body, $Headers, [switch] $SkipHttpErrorCheck, $MaximumRedirection, $TimeoutSec)
        $context.Requests.Add([pscustomobject]@{ Uri = $Uri; Authorization = $Headers.Authorization; MaximumRedirection = $MaximumRedirection })
        [pscustomobject]@{ StatusCode = $context.StatusCode; Content = '{}' }
    }
    $arguments = @{ Endpoint = 'https://collector.example.invalid'; AccessTokenScope = 'api://22222222-2222-4222-8222-222222222222/Telemetry.Write'; TenantId = $tenantId }
    foreach ($entry in $Overrides.GetEnumerator()) { $arguments[$entry.Key] = $entry.Value }
    $previousExitCode = $global:LASTEXITCODE
    try { & $verifyScript @arguments 6>$null | Out-Null }
    catch { $context.Error = $_.Exception.Message }
    finally { $global:LASTEXITCODE = $previousExitCode }
    return $context
}

Test-Case 'Remote delivery selects the requested tenant without changing the default account' {
    $result = Invoke-MockedRemote
    Assert-That (-not $result.Error) 'The valid remote fixture failed.'
    Assert-That ($result.CliCalls -eq 1) 'Expected one credential request.'
    Assert-That (($result.CliArguments -join ' ') -match "account get-access-token --tenant $tenantId --scope") 'The explicit tenant was not passed to Azure CLI.'
    Assert-That ($result.Requests.Count -eq 3) 'Expected all three OTLP signal requests.'
    foreach ($request in $result.Requests) {
        Assert-That ($request.Authorization -eq 'Bearer synthetic-test-token') 'A signal did not use the selected credential.'
        Assert-That ($request.MaximumRedirection -eq 0) 'Authenticated requests must not follow redirects.'
    }
}

Test-Case 'Remote delivery requires an explicit tenant before requesting credentials' {
    $result = Invoke-MockedRemote @{ TenantId = '' }
    Assert-That ($result.Error -match 'explicit.*TenantId') 'Missing tenant did not fail clearly.'
    Assert-That ($result.CliCalls -eq 0 -and $result.Requests.Count -eq 0) 'Missing tenant caused external work.'
}

Test-Case 'Invalid and placeholder tenant IDs fail before authentication' {
    foreach ($invalidTenant in @('not-a-tenant', '00000000-0000-0000-0000-000000000000')) {
        $result = Invoke-MockedRemote @{ TenantId = $invalidTenant }
        Assert-That ($result.Error -and $result.CliCalls -eq 0 -and $result.Requests.Count -eq 0) 'An invalid tenant reached authentication.'
    }
}

Test-Case 'Bearer credentials are never sent over HTTP' {
    $result = Invoke-MockedRemote @{ Endpoint = 'http://collector.example.invalid' }
    Assert-That ($result.Error -match 'HTTPS') 'HTTP remote endpoint was accepted.'
    Assert-That ($result.CliCalls -eq 0 -and $result.Requests.Count -eq 0) 'HTTP endpoint caused credential acquisition or delivery.'
}

Test-Case 'Ambiguous endpoint URLs fail before authentication' {
    foreach ($endpoint in @('https://user:password@collector.example.invalid', 'https://collector.example.invalid?query=value', 'https://collector.example.invalid#fragment', 'relative-path')) {
        $result = Invoke-MockedRemote @{ Endpoint = $endpoint }
        Assert-That ($result.Error -and $result.CliCalls -eq 0 -and $result.Requests.Count -eq 0) 'An ambiguous endpoint reached authentication.'
    }
}

Test-Case 'A credential from a different tenant is not sent' {
    $result = Invoke-MockedRemote @{} @{ TokenResult = (@{ accessToken = 'synthetic-test-token'; tenant = '33333333-3333-4333-8333-333333333333' } | ConvertTo-Json -Compress) }
    Assert-That ($result.Error -match 'requested tenant' -and $result.Requests.Count -eq 0) 'A wrong-tenant credential reached the collector.'
    Assert-That ($result.Error -notmatch 'synthetic-test-token') 'The credential leaked into an error.'
}

Test-Case 'Malformed and missing credentials fail without delivery or credential disclosure' {
    foreach ($credential in @('not-json', '{}', ('{"tenant":"' + $tenantId + '","accessToken":""}'))) {
        $result = Invoke-MockedRemote @{} @{ TokenResult = $credential }
        Assert-That ($result.Error -and $result.Requests.Count -eq 0) 'An invalid credential response reached delivery.'
        Assert-That ($result.Error -notmatch 'synthetic-test-token') 'The credential leaked into an error.'
    }
}

Test-Case 'Azure CLI failure never falls back to anonymous delivery' {
    $result = Invoke-MockedRemote @{} @{ CliExitCode = 1 }
    Assert-That ($result.Error -match 'Could not acquire' -and $result.Requests.Count -eq 0) 'Failed authentication attempted delivery.'
}

Test-Case 'A redirect is not treated as successful ingestion' {
    $result = Invoke-MockedRemote @{} @{ StatusCode = 302 }
    Assert-That ($result.Error -match 'HTTP 302' -and $result.Requests.Count -eq 1) 'A redirect did not stop the probe.'
}

Test-Case 'Offline payload generation never requests credentials' {
    $result = Invoke-MockedRemote @{ PayloadOnly = $true; TenantId = '' }
    Assert-That (-not $result.Error -and $result.CliCalls -eq 0 -and $result.Requests.Count -eq 0) 'Payload-only mode performed external work.'
}

if ($failures) { throw "$failures of $tests remote verification tests failed." }
Write-Host "All $tests remote verification tests passed. No Azure calls or HTTP delivery were performed." -ForegroundColor Green
