#Requires -Version 7.2
[CmdletBinding()]
param([switch] $IncludeTrust)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..' 'manage-dev-certificate.ps1'
$directory = Join-Path ([IO.Path]::GetTempPath()) "copilot-insights-cert-$([Guid]::NewGuid().ToString('N'))"
$name = 'certificate-test'
$failures = 0
$created = $null

function Test-Case([string] $title, [scriptblock] $body) {
    try { & $body; Write-Host "PASS  $title" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "FAIL  ${title}: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-That([bool] $condition, [string] $message) { if (-not $condition) { throw $message } }
function Assert-Rejected([scriptblock] $body, [string] $pattern) {
    $caught = $null
    try { & $body | Out-Null } catch { $caught = $_.Exception.Message }
    Assert-That ($null -ne $caught -and $caught -match $pattern) "Expected rejection matching '$pattern'; got '$caught'."
}
function Invoke-ManagedCertificate([string] $command) {
    & $scriptPath $command -Name $name -OutputDirectory $directory -Confirm:$false
}

try {
    Test-Case 'WhatIf does not create files or certificates' {
        & $scriptPath New -Name $name -DnsName localhost -OutputDirectory $directory -WhatIf
        Assert-That (-not (Test-Path -LiteralPath $directory)) 'WhatIf created a directory.'
    }
    Test-Case 'Source-controlled certificate directories are rejected' {
        Assert-Rejected { & $scriptPath New -DnsName localhost -OutputDirectory (Join-Path $PSScriptRoot 'private-certificate') } 'outside source control'
    }
    Test-Case 'Wildcards and missing DNS names are rejected' {
        Assert-Rejected { & $scriptPath New -OutputDirectory $directory } 'exact DNS names'
        Assert-Rejected { & $scriptPath New -DnsName '*.example.test' -OutputDirectory $directory } 'exact DNS names'
    }
    Test-Case 'Creation exports a protected PFX and public-only trust bundle' {
        $script:created = & $scriptPath New -Name $name -DnsName localhost,collector.example.test -ValidDays 1 -OutputDirectory $directory
        $public = [Security.Cryptography.X509Certificates.X509Certificate2]::new($created.CertificatePath)
        try {
            Assert-That (-not $public.HasPrivateKey) 'The public trust file contains a private key.'
            Assert-That ($public.Subject -eq $public.Issuer) 'Expected a self-signed certificate.'
            Assert-That ($public.NotAfter -lt (Get-Date).AddDays(2)) 'Certificate lifetime is too long.'
            Assert-That ($public.Thumbprint -eq $created.Thumbprint) 'Wrong public certificate.'
        } finally { $public.Dispose() }
        $password = (Get-Content -Raw -LiteralPath $created.ProtectedPasswordPath).Trim() | ConvertTo-SecureString
        $private = [Security.Cryptography.X509Certificates.X509Certificate2]::new($created.PfxPath, $password, 'EphemeralKeySet')
        try { Assert-That $private.HasPrivateKey 'The PFX cannot be opened using the current-user protected password.' }
        finally { $private.Dispose(); $password.Dispose() }
        Assert-That ((Get-Acl -LiteralPath $directory).AreAccessRulesProtected) 'The directory inherits access from its parent.'
        Assert-That (-not (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$($created.Thumbprint)")) 'Creation implicitly trusted the certificate.'
        Assert-That ((Get-Content -Raw -LiteralPath $created.PemPath) -match '^-----BEGIN CERTIFICATE-----') 'Missing PEM trust bundle.'
    }
    Test-Case 'Creation never overwrites an existing certificate' {
        Assert-Rejected { & $scriptPath New -Name $name -DnsName localhost -OutputDirectory $directory } 'must be empty'
    }
    if ($IncludeTrust) { Test-Case 'Explicit trust is current-user only and can be reversed' {
        Invoke-ManagedCertificate Trust | Out-Null
        Assert-That (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$($created.Thumbprint)") 'The certificate is not trusted.'
        Assert-That (-not (Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($created.Thumbprint)")) 'Machine-wide trust was changed.'
        Invoke-ManagedCertificate Untrust | Out-Null
        Assert-That (-not (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$($created.Thumbprint)")) 'Trust was not reversed.'
    } }
    Test-Case 'Trust fails if the public file does not match the recorded certificate' {
        $statePath = Join-Path $directory 'state.json'
        $original = [IO.File]::ReadAllBytes($statePath)
        try {
            $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            $state.thumbprint = 'A' * 40
            $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath
            Assert-Rejected { Invoke-ManagedCertificate Trust } 'does not match'
        } finally { [IO.File]::WriteAllBytes($statePath, $original) }
    }
    Test-Case 'Remove deletes only generated material and reverses any script-owned trust' {
        if ($IncludeTrust) { Invoke-ManagedCertificate Trust | Out-Null }
        Invoke-ManagedCertificate Remove | Out-Null
        Assert-That (-not (Test-Path -LiteralPath $directory)) 'Generated directory remains.'
        Assert-That (-not (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$($created.Thumbprint)")) 'Trust remains.'
        Assert-That (-not (Test-Path -LiteralPath "Cert:\CurrentUser\My\$($created.Thumbprint)")) 'Personal certificate remains.'
    }
} finally {
    if (Test-Path -LiteralPath (Join-Path $directory 'state.json')) { Invoke-ManagedCertificate Remove | Out-Null }
}
if ($failures) { throw "$failures certificate test(s) failed." }
Write-Host 'All certificate lifecycle tests passed.' -ForegroundColor Green
