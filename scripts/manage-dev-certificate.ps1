#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('New', 'Trust', 'Untrust', 'Remove', 'Status')]
    [string] $Command,
    [ValidatePattern('^[a-z][a-z0-9-]{1,62}$')]
    [string] $Name = 'azure-validation',
    [string[]] $DnsName,
    [ValidateRange(1, 30)]
    [int] $ValidDays = 7,
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Development certificate management requires Windows and the current-user certificate store.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $env:LOCALAPPDATA "CopilotInsights/Certificates/$Name" }
$directory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory).TrimEnd('\', '/')
$root = [IO.Path]::GetPathRoot($directory).TrimEnd('\', '/')
if ($directory -eq $root) { throw 'Use a dedicated certificate directory, not a drive root.' }
$ancestor = $directory
while ($ancestor) {
    if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) { throw 'Certificates and passwords must be stored outside source control.' }
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Certificate storage must not pass through a junction or symbolic link.'
    }
    $ancestor = Split-Path -Parent $ancestor
}
$statePath = Join-Path $directory 'state.json'
$certificatePath = Join-Path $directory 'certificate.cer'
$pfxPath = Join-Path $directory 'certificate.pfx'
$pemPath = Join-Path $directory 'certificate.pem'
$passwordPath = Join-Path $directory 'password.dpapi'

function Save-State($state) {
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
}

function Get-State {
    if (-not (Test-Path -LiteralPath $statePath)) { throw 'No managed certificate exists in this directory.' }
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($state.version -ne 1 -or $state.thumbprint -cnotmatch '^[A-F0-9]{40}$' -or $state.name -ne $Name -or
        $state.ownerSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
        throw 'Certificate state does not match this name and Windows user.'
    }
    return $state
}

function Get-PublicCertificate($state) {
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
    if ($certificate.Thumbprint -ne $state.thumbprint -or $certificate.HasPrivateKey -or
        $certificate.Subject -ne $certificate.Issuer) {
        $certificate.Dispose()
        throw 'The public certificate does not match the recorded self-signed certificate.'
    }
    return $certificate
}

function Set-CurrentUserTrust($state, [bool] $trusted) {
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    try {
        $store.Open('ReadOnly')
        $matches = $store.Certificates.Find('FindByThumbprint', $state.thumbprint, $false)
        if ($trusted) {
            $certificate = Get-PublicCertificate $state
            try {
                if ($certificate.NotAfter -le (Get-Date)) { throw 'The certificate has expired; create a new one instead.' }
                if ($matches.Count -eq 0) {
                    $state.trustAdded = $true
                    Save-State $state
                    Write-Host "If Windows asks for confirmation, verify thumbprint $($state.thumbprint) before accepting."
                    & certutil.exe -user -f -addstore Root $certificatePath | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw 'Windows refused the current-user trust import.' }
                }
            } finally { $certificate.Dispose() }
        } elseif ($state.trustAdded) {
            if ($matches.Count -gt 0) {
                & certutil.exe -user -delstore Root $state.thumbprint | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Windows refused to remove the tracked trust entry.' }
            }
            $state.trustAdded = $false
            Save-State $state
        }
    } finally { $store.Dispose() }
}

if ($Command -eq 'New') {
    if (-not $DnsName -or $DnsName.Count -gt 5 -or @($DnsName | Where-Object {
        [Uri]::CheckHostName($_) -ne [UriHostNameType]::Dns -or $_.Contains('*') -or $_.Length -gt 253
    }).Count) { throw 'Supply one to five exact DNS names. Wildcards and IP addresses are not accepted.' }
    if ((Test-Path -LiteralPath $directory) -and @(Get-ChildItem -LiteralPath $directory -Force).Count) {
        throw 'The certificate directory must be empty. Remove the previous managed certificate explicitly before replacing it.'
    }
    if (-not $PSCmdlet.ShouldProcess($directory, 'Create a short-lived self-signed TLS certificate and protected PFX; do not trust yet')) { return }
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($ownerSid, 'S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    $certificate = New-SelfSignedCertificate -Type SSLServerAuthentication -DnsName $DnsName `
        -CertStoreLocation 'Cert:\CurrentUser\My' -FriendlyName "Copilot Insights development: $Name" `
        -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddDays($ValidDays)
    try {
        $state = [pscustomobject]@{
            version = 1; name = $Name; ownerSid = $ownerSid; thumbprint = $certificate.Thumbprint
            dnsNames = @($DnsName); expiresUtc = $certificate.NotAfter.ToUniversalTime().ToString('o'); trustAdded = $false
        }
        Save-State $state
        $password = ConvertTo-SecureString ([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))) -AsPlainText -Force
        $password | ConvertFrom-SecureString | Set-Content -LiteralPath $passwordPath -Encoding utf8
        Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -CryptoAlgorithmOption AES256_SHA256 | Out-Null
        Export-Certificate -Cert $certificate -FilePath $certificatePath | Out-Null
        [IO.File]::WriteAllText($pemPath, $certificate.ExportCertificatePem(), [Text.UTF8Encoding]::new($false))
    } finally { $certificate.Dispose() }
} else {
    $state = Get-State
    if ($Command -eq 'Trust' -and $PSCmdlet.ShouldProcess($state.thumbprint, 'Trust only this certificate in CurrentUser\Root')) {
        Set-CurrentUserTrust $state $true
    } elseif ($Command -eq 'Untrust' -and $PSCmdlet.ShouldProcess($state.thumbprint, 'Remove only the trust entry added by this script')) {
        Set-CurrentUserTrust $state $false
    } elseif ($Command -eq 'Remove') {
        if (-not $PSCmdlet.ShouldProcess($directory, 'Remove the tracked certificate, its script-owned trust entry, and generated files')) { return }
        Set-CurrentUserTrust $state $false
        $personalPath = "Cert:\CurrentUser\My\$($state.thumbprint)"
        if (Test-Path -LiteralPath $personalPath) { Remove-Item -LiteralPath $personalPath -DeleteKey }
        foreach ($path in @($pfxPath, $certificatePath, $pemPath, $passwordPath, $statePath)) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
        }
        if (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) { Remove-Item -LiteralPath $directory }
        Write-Output 'Removed the managed development certificate. Unrelated trust entries were not changed.'
        return
    }
}
$state = Get-State
[pscustomobject]@{
    Name = $state.name
    DnsNames = $state.dnsNames
    Thumbprint = $state.thumbprint
    ExpiresUtc = ([DateTimeOffset]$state.expiresUtc).ToUniversalTime().ToString('o')
    TrustedInCurrentUserRoot = Test-Path -LiteralPath "Cert:\CurrentUser\Root\$($state.thumbprint)"
    TrustedByThisScript = $state.trustAdded -and (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$($state.thumbprint)")
    CertificatePath = $certificatePath
    PfxPath = $pfxPath
    PemPath = $pemPath
    ProtectedPasswordPath = $passwordPath
}
