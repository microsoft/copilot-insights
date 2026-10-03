#Requires -Version 7.2
<#
.SYNOPSIS
Connects VS Code on this machine to Copilot Insights, shows its status, or removes it again.

.DESCRIPTION
For local development and controlled administrator diagnostics. Organization production deployment uses Intune;
this script is not an employee onboarding package or an unattended production credential solution.

Install adds one clearly marked block of GitHub Copilot OpenTelemetry settings to your VS Code user settings and
changes nothing else in that file. Uninstall removes exactly that block. Content and identity capture stay off.

Choose where telemetry goes:
  -Local                VS Code sends to the local quick-start collector (docker compose) on this machine.
  -Endpoint and -Scope  VS Code sends to a forwarder on this machine: the pinned OpenTelemetry Collector, running
                        as you on 127.0.0.1. It removes excluded fields before anything leaves the machine, then
                        forwards to your organization's collector with a Microsoft Entra ID token from your Azure
                        CLI sign-in. VS Code never holds a credential. Windows only.

Actions:
  Install    Check prerequisites, set up the forwarder (unless -Local), and add the settings block.
  Start      Start the forwarder. Run this after you sign in to Windows again.
  Stop       Stop the forwarder. Nothing leaves the machine until you start it again.
  Status     Show the configuration and whether telemetry can flow. Exits with 1 when something needs attention.
  Uninstall  Stop the forwarder, remove the settings block, and delete the files this script installed.
  Restore    Restore the private snapshot from Install -Local -Temporary, preserving original settings bytes.

Install -Local -Temporary permits an existing user OTel configuration for a short local test.
Restore (or restore-client.ps1) restores the original settings bytes and refuses concurrent edits.
Reload VS Code windows after Install, Uninstall, and Restore. Every action supports -WhatIf.

.EXAMPLE
./scripts/setup-client.ps1 Install -Local

.EXAMPLE
./scripts/setup-client.ps1 Install -Endpoint https://collector.example.org -Scope api://00000000-0000-0000-0000-000000000000/Telemetry.Write -Cohort team-a
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall', 'Restore')]
    [string] $Action,
    [string] $Endpoint,
    [string] $Scope,
    [switch] $Local,
    [switch] $Temporary,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')]
    [string] $Cohort,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')]
    [string] $Ring,
    [string] $SettingsPath,
    [string] $InstallRoot,
    [string] $CollectorArchive
)

$ErrorActionPreference = 'Stop'

# Bump ConfigVersion whenever the generated settings or forwarder configuration change.
$ConfigVersion = '0.1.0'
$CollectorVersion = '0.161.0'
$CollectorSha256 = 'fd1a6d23aa7855efc4fc12e4ee2c21b410e0a35c85587a07def7746eec9cea24'
$CollectorUrl = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v$CollectorVersion/otelcol-contrib_${CollectorVersion}_windows_amd64.tar.gz"
$ForwarderPort = 4319
$ForwarderHealthPort = 13134
$LocalEndpoint = 'http://localhost:4318'
$LocalHealthEndpoint = 'http://localhost:13133/'
$BlockBegin = '/* >>> copilot-insights: managed by setup-client.ps1; remove with "setup-client.ps1 Uninstall" */'
$BlockEnd = '/* <<< copilot-insights */'
$BlockPattern = '\r?\n[ \t]*/\* >>> copilot-insights.*?/\* <<< copilot-insights \*/'

if (-not $InstallRoot) {
    $InstallRoot = if ($IsWindows) { Join-Path $env:LOCALAPPDATA 'CopilotInsights' } else { Join-Path $HOME '.local/share/copilot-insights' }
}
$InstallRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallRoot)
$statePath = Join-Path $InstallRoot 'state.json'
$restorePath = Join-Path $InstallRoot 'local-restore.json'
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json -AsHashtable } else { $null }
if (-not $SettingsPath) {
    $SettingsPath = if ($state) { $state.settingsPath }
    elseif (Test-Path -LiteralPath $restorePath) { (Get-Content -LiteralPath $restorePath -Raw | ConvertFrom-Json -AsHashtable).settingsPath }
    elseif ($IsWindows) { Join-Path $env:APPDATA 'Code/User/settings.json' }
    elseif ($IsMacOS) { Join-Path $HOME 'Library/Application Support/Code/User/settings.json' }
    else { Join-Path ($env:XDG_CONFIG_HOME ?? (Join-Path $HOME '.config')) 'Code/User/settings.json' }
}
$SettingsPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SettingsPath)
$binDir = Join-Path $InstallRoot "bin/$CollectorVersion"
$exePath = Join-Path $binDir 'otelcol-contrib.exe'
$configDir = Join-Path $InstallRoot 'config'
$logPath = Join-Path $InstallRoot 'logs/forwarder.log'
$forwarderHealthUrl = "http://127.0.0.1:$ForwarderHealthPort/"

function Write-Line([string] $message) { Write-Host "  $message" }

function Test-Health([string] $url) {
    try { (Invoke-WebRequest -Uri $url -SkipHttpErrorCheck -TimeoutSec 3).StatusCode -eq 200 } catch { $false }
}

# ------------------------------------------------------------------ VS Code settings

function Read-Settings {
    $text = ''
    $bom = $false
    $exists = Test-Path -LiteralPath $SettingsPath
    if ($exists) {
        $bytes = [IO.File]::ReadAllBytes($SettingsPath)
        $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        $offset = if ($bom) { 3 } else { 0 }
        $text = [Text.UTF8Encoding]::new($false).GetString($bytes, $offset, $bytes.Length - $offset)
    }
    $found = [regex]::Matches($text, $BlockPattern, 'Singleline')
    if ($found.Count -gt 1) { throw "$SettingsPath contains more than one Copilot Insights block. Remove the extra block, then rerun." }
    $withoutBlock = if ($found.Count -eq 1) { $text.Remove($found[0].Index, $found[0].Length) } else { $text }
    if ($withoutBlock -match '>>> copilot-insights|<<< copilot-insights') {
        throw "The Copilot Insights block markers in $SettingsPath are incomplete. Remove the block manually, then rerun."
    }
    $parsed = @{}
    if (-not [string]::IsNullOrWhiteSpace($withoutBlock)) {
        try { $parsed = $withoutBlock | ConvertFrom-Json -AsHashtable } catch { throw "VS Code settings at $SettingsPath could not be parsed: $($_.Exception.Message) Fix the file in VS Code, then rerun." }
        if ($null -eq $parsed) { $parsed = @{} }
        if ($parsed -isnot [Collections.IDictionary]) { throw "$SettingsPath does not contain a JSON object." }
    }
    [pscustomobject]@{ Exists = $exists; Text = $text; WithoutBlock = $withoutBlock; HasBlock = $found.Count -eq 1; Bom = $bom; Parsed = $parsed; Bytes = $(if ($exists) { $bytes } else { [byte[]]@() }) }
}

function Write-Settings([string] $text, [bool] $bom) {
    $directory = Split-Path -Parent $SettingsPath
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $temporary = "$SettingsPath.copilot-insights.tmp"
    [IO.File]::WriteAllText($temporary, $text, [Text.UTF8Encoding]::new($bom))
    Move-Item -LiteralPath $temporary -Destination $SettingsPath -Force
}

function Get-ObjectStart([string] $text) {
    $i = 0
    while ($i -lt $text.Length) {
        $c = $text[$i]
        if ([char]::IsWhiteSpace($c)) { $i++; continue }
        if ($c -eq '/' -and $i + 1 -lt $text.Length -and $text[$i + 1] -eq '/') { $i = $text.IndexOf("`n", $i); if ($i -lt 0) { break }; continue }
        if ($c -eq '/' -and $i + 1 -lt $text.Length -and $text[$i + 1] -eq '*') { $end = $text.IndexOf('*/', $i + 2); if ($end -lt 0) { break }; $i = $end + 2; continue }
        if ($c -eq '{') { return $i + 1 }
        break
    }
    throw "$SettingsPath does not contain a JSON object."
}

function Add-SettingsBlock($settings, [Collections.Specialized.OrderedDictionary] $values) {
    $text = if ([string]::IsNullOrWhiteSpace($settings.WithoutBlock)) { "{`n}" } else { $settings.WithoutBlock }
    $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $indent = if ($text -match '(?m)^([ \t]+)"') { $Matches[1] } else { "`t" }
    $keys = @($values.Keys)
    $lines = for ($k = 0; $k -lt $keys.Count; $k++) {
        $comma = if ($k -lt $keys.Count - 1 -or $settings.Parsed.Count -gt 0) { ',' } else { '' }
        $indent + (ConvertTo-Json -InputObject $keys[$k] -Compress) + ': ' + (ConvertTo-Json -InputObject $values[$keys[$k]] -Compress -Depth 5) + $comma
    }
    $block = $eol + $indent + $BlockBegin + $eol + ($lines -join $eol) + $eol + $indent + $BlockEnd
    $at = Get-ObjectStart $text
    $text.Insert($at, $block)
}

function Assert-SettingsAllowInstall($settings, [bool] $allowExisting = $false) {
    $conflicts = @($settings.Parsed.Keys | Where-Object { $_ -like 'github.copilot.chat.otel.*' })
    if ($conflicts -and -not $allowExisting) {
        throw "Your VS Code settings already configure Copilot OpenTelemetry ($($conflicts -join ', ')). Keep your own configuration, or use Install -Local -Temporary for a reversible local test."
    }
    if ($settings.Parsed['telemetry.telemetryLevel'] -eq 'off' -or $settings.Parsed['telemetry.enableTelemetry'] -eq $false) {
        throw 'VS Code telemetry is turned off in your settings (telemetry.telemetryLevel), and Copilot does not export OpenTelemetry while it is off. Copilot Insights respects that choice, so nothing was changed.'
    }
}

function Get-BytesHash([byte[]] $bytes) {
    if ($null -eq $bytes) { $bytes = [byte[]]::new(0) }
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$bytes))
}

function Get-SettingsHash {
    if (Test-Path -LiteralPath $SettingsPath) { Get-BytesHash ([IO.File]::ReadAllBytes($SettingsPath)) } else { 'missing' }
}

function Get-TemporarySettings($settings) {
    $options = [Text.Json.JsonDocumentOptions]::new()
    $options.AllowTrailingCommas = $true
    $options.CommentHandling = [Text.Json.JsonCommentHandling]::Skip
    $options.MaxDepth = 1024
    $text = if ([string]::IsNullOrWhiteSpace($settings.Text)) { '{}' } else { $settings.Text }
    $document = [Text.Json.Nodes.JsonNode]::Parse($text, [Text.Json.Nodes.JsonNodeOptions]::new(), $options).AsObject()
    foreach ($key in @($settings.Parsed.Keys | Where-Object { $_ -like 'github.copilot.chat.otel.*' })) {
        [void]$document.Remove($key)
    }
    $writerOptions = [Text.Json.JsonSerializerOptions]::new()
    $writerOptions.WriteIndented = $true
    $writerOptions.MaxDepth = 1024
    $text = $document.ToJsonString($writerOptions)
    if ($settings.Text.Contains("`r`n")) { $text = $text.Replace("`n", "`r`n") }
    [pscustomobject]@{ WithoutBlock = $text; Parsed = ($text | ConvertFrom-Json -AsHashtable); Bom = $settings.Bom }
}

function Assert-TemporaryEnvironment {
    $scopes = if ($IsWindows) { 'Process', 'User', 'Machine' } else { , 'Process' }
    foreach ($scope in $scopes) {
        $variables = [Environment]::GetEnvironmentVariables($scope)
        foreach ($name in $variables.Keys) {
            if ($name -notmatch '^(COPILOT_OTEL_|OTEL_)') { continue }
            if ($name -eq 'COPILOT_OTEL_EXPORTER_TYPE' -and $variables[$name] -eq 'otlp-http') { continue }
            if ($name -eq 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT' -and $variables[$name] -eq 'false') { continue }
            throw "Temporary local setup cannot verify environment override $name ($scope). Nothing was changed. Use a clean test process; do not override organizational configuration."
        }
    }
}

function Invoke-Restore {
    if (-not (Test-Path -LiteralPath $restorePath)) {
        Write-Host 'No temporary local settings snapshot exists. Nothing was changed.'
        return
    }
    $snapshot = Get-Content -LiteralPath $restorePath -Raw | ConvertFrom-Json -AsHashtable
    if ($snapshot.schemaVersion -ne 1 -or [IO.Path]::GetFullPath($SettingsPath) -ne $snapshot.settingsPath) {
        throw 'The restore snapshot does not match this settings path. Nothing was changed.'
    }
    $originalBytes = [Convert]::FromBase64String($snapshot.originalBase64)
    $originalHash = if ($snapshot.originalExists) { Get-BytesHash $originalBytes } else { 'missing' }
    if ($originalHash -ne $snapshot.originalSha256) { throw 'The restore snapshot failed its integrity check. Nothing was changed.' }
    $currentHash = Get-SettingsHash
    if ($currentHash -ne $snapshot.appliedSha256 -and $currentHash -ne $originalHash) {
        throw "Settings changed after temporary setup. Refusing to overwrite concurrent edits. The original snapshot remains at $restorePath; reconcile those edits before retrying Restore."
    }
    if ($state -and (-not $state.temporary -or [IO.Path]::GetFullPath($state.settingsPath) -ne $snapshot.settingsPath)) {
        throw 'An unrelated installation now uses this state directory. Nothing was changed.'
    }
    if (-not $PSCmdlet.ShouldProcess($SettingsPath, 'Restore the original VS Code settings and remove the temporary snapshot')) { return }
    if ((Get-SettingsHash) -ne $currentHash) { throw 'Settings changed during restoration. Original snapshot retained.' }
    if ($currentHash -ne $originalHash) {
        if ($snapshot.originalExists) {
            $temporaryPath = "$SettingsPath.copilot-insights.tmp"
            [IO.File]::WriteAllBytes($temporaryPath, $originalBytes)
            if ((Get-SettingsHash) -ne $currentHash) { throw 'Settings changed during restoration. Original snapshot retained.' }
            Move-Item -LiteralPath $temporaryPath -Destination $SettingsPath -Force
        } else {
            Remove-Item -LiteralPath $SettingsPath
        }
    }
    if ((Get-SettingsHash) -ne $originalHash) { throw 'Restoration could not be verified. Original snapshot retained.' }
    if ($state) { Remove-Item -LiteralPath $statePath }
    Remove-Item -LiteralPath $restorePath
    if (-not (Get-ChildItem -LiteralPath $InstallRoot -Force)) { Remove-Item -LiteralPath $InstallRoot }
    Write-Host 'Original VS Code settings restored and verified byte for byte. Reload the test window (or close it) to discard its temporary exporter configuration.'
}

# ------------------------------------------------------------------ environment checks

function Get-PolicyTelemetryOff {
    if (-not $IsWindows) { return $false }
    foreach ($key in 'HKLM:\SOFTWARE\Policies\Microsoft\VSCode', 'HKCU:\SOFTWARE\Policies\Microsoft\VSCode') {
        $value = (Get-ItemProperty -LiteralPath $key -Name 'TelemetryLevel' -ErrorAction SilentlyContinue).TelemetryLevel
        if ($value -eq 'off') { return $true }
    }
    $false
}

function Get-PolicyHints {
    if (-not $IsWindows) { return @() }
    $hints = foreach ($key in 'HKLM:\SOFTWARE\Policies\Microsoft\VSCode', 'HKCU:\SOFTWARE\Policies\Microsoft\VSCode', 'HKLM:\SOFTWARE\Policies\GitHubCopilot', 'HKCU:\SOFTWARE\Policies\GitHubCopilot') {
        if (Test-Path -LiteralPath $key) {
            foreach ($name in (Get-Item -LiteralPath $key).Property) { if ($name -match '(?i)otel|telemetry') { "$key\$name" } }
        }
    }
    @($hints)
}

function Get-EnvironmentOverrides {
    $names = [Collections.Generic.SortedSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $scopes = if ($IsWindows) { 'Process', 'User', 'Machine' } else { , 'Process' }
    foreach ($scope in $scopes) {
        foreach ($name in [Environment]::GetEnvironmentVariables($scope).Keys) {
            if ($name -match '^(COPILOT_OTEL_|OTEL_)') { [void]$names.Add($name) }
        }
    }
    @($names)
}

function Get-TokenProblem([string] $tokenScope) {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) { return 'Azure CLI (az) is not installed or not on PATH. Install it, run "az login", and try again.' }
    $ErrorActionPreference = 'Continue'
    $output = @(& az account get-access-token --scope $tokenScope --query expiresOn -o tsv 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -eq 0) { return $null }
    $reason = $output | Where-Object { $_ -match 'AADSTS\d+|az login|ERROR' } | Select-Object -First 1
    "Azure CLI could not get a token for $tokenScope. $reason"
}

# ------------------------------------------------------------------ forwarder

function Get-ForwarderProcess {
    if (-not $IsWindows) { return @() }
    $target = [IO.Path]::GetFullPath($exePath)
    @(Get-Process -Name 'otelcol-contrib' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $target })
}

function Install-Forwarder {
    if (Test-Path -LiteralPath $exePath) {
        Write-Line "OpenTelemetry Collector $CollectorVersion is already installed."
    } else {
        $archive = $CollectorArchive
        $downloaded = $false
        if (-not $archive) {
            $archive = Join-Path ([IO.Path]::GetTempPath()) "otelcol-contrib_${CollectorVersion}_windows_amd64.tar.gz"
            if ($PSCmdlet.ShouldProcess($CollectorUrl, 'Download OpenTelemetry Collector')) {
                Write-Line "Downloading OpenTelemetry Collector $CollectorVersion..."
                $ProgressPreference = 'SilentlyContinue'
                Invoke-WebRequest -Uri $CollectorUrl -OutFile $archive
                $downloaded = $true
            }
        }
        if ($PSCmdlet.ShouldProcess($binDir, "Verify and extract OpenTelemetry Collector $CollectorVersion")) {
            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
            if ($hash -ne $CollectorSha256) { throw "Checksum mismatch for $archive (expected $CollectorSha256, got $hash). Nothing was installed." }
            New-Item -ItemType Directory -Path $binDir -Force | Out-Null
            tar -xzf $archive -C $binDir otelcol-contrib.exe
            if ($LASTEXITCODE -ne 0) { throw "Extracting $archive failed." }
            if ($downloaded) { Remove-Item -LiteralPath $archive }
            Write-Line "Installed OpenTelemetry Collector $CollectorVersion (checksum verified)."
        }
    }
    if ($PSCmdlet.ShouldProcess($configDir, 'Copy forwarder configuration')) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        foreach ($name in 'base.yaml', 'forwarder.yaml') {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../collector/config/$name") -Destination (Join-Path $configDir $name) -Force
        }
    }
}

function Start-Forwarder {
    if (-not $state -or $state.mode -ne 'forwarder') { Write-Line 'Nothing to start: this machine is not set up with a forwarder.'; return }
    if (Test-Health $forwarderHealthUrl) { Write-Line 'The forwarder is already running.'; return }
    if (-not (Test-Path -LiteralPath $exePath)) { throw 'The forwarder is not installed. Run Install first.' }
    if (-not $PSCmdlet.ShouldProcess($exePath, 'Start forwarder')) { return }
    New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 5MB) { Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force }
    $variables = @{
        CI_UPSTREAM_ENDPOINT = $state.endpoint; CI_UPSTREAM_SCOPE = $state.scope; CI_FORWARDER_LOG_PATH = $logPath
        CI_FORWARDER_PORT = "$ForwarderPort"; CI_FORWARDER_HEALTH_PORT = "$ForwarderHealthPort"; AZURE_TOKEN_CREDENTIALS = 'AzureCLICredential'
    }
    $saved = @{}
    foreach ($name in $variables.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name); Set-Item -LiteralPath "env:$name" -Value $variables[$name] }
    try {
        $arguments = foreach ($name in 'base.yaml', 'forwarder.yaml') { '--config="{0}"' -f (Join-Path $configDir $name) }
        Start-Process -FilePath $exePath -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    } finally {
        # Restore this session's environment; assigning $null through .NET would leave empty variables behind.
        foreach ($name in $saved.Keys) {
            if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "env:$name" -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath "env:$name" -Value $saved[$name] }
        }
    }
    # The first start after installation can be slow while antivirus software scans the new binary.
    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Test-Health $forwarderHealthUrl)) {
        if ((Get-Date) -gt $deadline) { throw "The forwarder did not start within 90 seconds. See $logPath." }
        Start-Sleep -Milliseconds 500
    }
    Write-Line "Forwarder running on 127.0.0.1:$ForwarderPort."
}

function Stop-Forwarder {
    $processes = Get-ForwarderProcess
    foreach ($process in $processes) {
        if ($PSCmdlet.ShouldProcess("forwarder process $($process.Id)", 'Stop')) {
            Stop-Process -Id $process.Id
            $process.WaitForExit(10000) | Out-Null
        }
    }
    $processes.Count
}

# ------------------------------------------------------------------ actions

function Invoke-Install {
    if (Test-Path -LiteralPath $restorePath) { throw 'A temporary local setup is active. Run restore-client.ps1 before installing again.' }
    if ($Local -and ($Endpoint -or $Scope)) { throw 'Use either -Local, or -Endpoint with -Scope.' }
    if (-not $Local -and -not ($Endpoint -and $Scope)) { throw 'Install needs -Local, or the -Endpoint and -Scope values from your administrator.' }
    $mode = if ($Local) { 'local' } else { 'forwarder' }
    Write-Host "Setting up Copilot Insights ($mode)"

    if ($mode -eq 'forwarder') {
        if (-not $IsWindows) { throw 'The forwarder currently supports Windows only. Use -Local on this machine.' }
        $uri = $null
        if (-not [Uri]::TryCreate($Endpoint, 'Absolute', [ref] $uri) -or $uri.UserInfo -or -not ($uri.Scheme -eq 'https' -or ($uri.Scheme -eq 'http' -and $uri.IsLoopback))) {
            throw "-Endpoint must be an https:// URL without credentials (got '$Endpoint')."
        }
        if ($Scope -notmatch '^(api|https)://\S+$') { throw "-Scope must look like api://<application-id>/Telemetry.Write (got '$Scope')." }
        $problem = Get-TokenProblem $Scope
        if ($problem) { throw "$problem Ask your administrator to confirm you are assigned to the ingestion application." }
        Write-Line 'Azure CLI can get an ingestion token.'
    }

    $settings = Read-Settings
    if ($Temporary -and ($state -or $settings.HasBlock)) { throw 'Temporary setup cannot replace an installed Copilot Insights client. Restore or uninstall that installation first.' }
    Assert-SettingsAllowInstall $settings ([bool]$Temporary)
    if (Get-PolicyTelemetryOff) { throw 'VS Code telemetry is turned off by policy on this machine, so Copilot does not export OpenTelemetry. Nothing was changed.' }
    if ($Temporary) {
        if (Get-PolicyHints) { throw 'Telemetry policy is present. Temporary setup will not override managed configuration.' }
        Assert-TemporaryEnvironment
    }
    foreach ($hint in Get-PolicyHints) { Write-Warning "Policy value $hint may override these settings. Run Status after setup to confirm." }
    $overrides = Get-EnvironmentOverrides
    if ($overrides -and $Temporary) { Write-Line "Compatible environment flags checked: $($overrides -join ', '). No environment variables were changed." }
    elseif ($overrides) { Write-Warning "These environment variables override VS Code settings for Copilot: $($overrides -join ', '). Resolve them with your administrator, or telemetry may go elsewhere." }

    if ($mode -eq 'forwarder') { Install-Forwarder } elseif (-not $Temporary -and (Stop-Forwarder) -gt 0) { Write-Line 'Stopped the previously configured forwarder.' }

    $ringValue = if ($Ring) { $Ring } elseif ($Local) { 'local' } else { 'pilot' }
    $attributes = [ordered]@{ 'copilot_insights.config.version' = $ConfigVersion; 'copilot_insights.rollout.ring' = $ringValue }
    if ($Cohort) { $attributes['copilot_insights.cohort.id'] = $Cohort }
    $clientEndpoint = if ($Local) { $LocalEndpoint } else { "http://127.0.0.1:$ForwarderPort" }
    $values = [ordered]@{
        'github.copilot.chat.otel.enabled'            = $true
        'github.copilot.chat.otel.exporterType'       = 'otlp-http'
        'github.copilot.chat.otel.otlpEndpoint'       = $clientEndpoint
        'github.copilot.chat.otel.captureContent'     = $false
        'github.copilot.chat.otel.captureIdentity'    = $false
        'github.copilot.chat.otel.resourceAttributes' = $attributes
    }
    $preparedSettings = if ($Temporary) { Get-TemporarySettings $settings } else { $settings }
    $newText = Add-SettingsBlock $preparedSettings $values
    [byte[]]$originalBytes = $settings.Bytes ?? [byte[]]::new(0)
    $originalHash = if ($settings.Exists) { Get-BytesHash $originalBytes } else { 'missing' }
    $encoding = [Text.UTF8Encoding]::new($settings.Bom)
    $expectedBytes = [byte[]]($encoding.GetPreamble() + $encoding.GetBytes($newText))
    $appliedHash = Get-BytesHash $expectedBytes
    if ($PSCmdlet.ShouldProcess($SettingsPath, 'Add the Copilot Insights settings block')) {
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        if ($Temporary) {
            $snapshot = [ordered]@{
                schemaVersion = 1
                settingsPath = [IO.Path]::GetFullPath($SettingsPath)
                originalExists = $settings.Exists
                originalBase64 = [Convert]::ToBase64String($originalBytes)
                originalSha256 = $originalHash
                appliedSha256 = $appliedHash
            }
            [IO.File]::WriteAllText($restorePath, ($snapshot | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        } elseif ($settings.Exists) {
            $backups = Join-Path $InstallRoot 'backups'
            New-Item -ItemType Directory -Path $backups -Force | Out-Null
            Copy-Item -LiteralPath $SettingsPath -Destination (Join-Path $backups ('settings-{0:yyyyMMdd-HHmmss}.json' -f (Get-Date)))
        }
        $settingsWritten = $false
        try {
            if ((Get-SettingsHash) -ne $originalHash) { throw 'Settings changed during setup. Refusing to overwrite concurrent edits.' }
            Write-Settings $newText $settings.Bom
            $settingsWritten = $true
            $check = Read-Settings
            if (-not $check.HasBlock -or $check.Parsed.Count -ne $preparedSettings.Parsed.Count -or ($newText | ConvertFrom-Json -AsHashtable)['github.copilot.chat.otel.otlpEndpoint'] -ne $clientEndpoint) {
                throw "Updating $SettingsPath could not be verified."
            }
            $script:state = [ordered]@{ mode = $mode; endpoint = $Endpoint; scope = $Scope; settingsPath = $SettingsPath; configVersion = $ConfigVersion; collectorVersion = $CollectorVersion; temporary = [bool]$Temporary }
            Set-Content -LiteralPath $statePath -Value ($script:state | ConvertTo-Json)
        } catch {
            if ($Temporary) { Invoke-Restore }
            elseif ($settingsWritten -and (Get-SettingsHash) -eq $appliedHash) {
                if ($settings.Exists) { Write-Settings $settings.Text $settings.Bom } else { Remove-Item -LiteralPath $SettingsPath }
            }
            throw
        }
        Write-Line "Added the settings block to $SettingsPath."
    }

    if ($WhatIfPreference) { return }
    if ($mode -eq 'forwarder') { Start-Forwarder }

    $target = if ($Local) { "the local quick-start collector ($LocalEndpoint)" } else { "the forwarder on 127.0.0.1:$ForwarderPort, then $Endpoint" }
    Write-Host ''
    Write-Host "Done. Copilot telemetry will go to $target."
    Write-Host 'Next:'
    Write-Host '  1. Reload VS Code windows (Command Palette: Developer: Reload Window).'
    Write-Host '  2. Use Copilot agent chat, then run: ./scripts/setup-client.ps1 Status'
    if ($Temporary) { Write-Host '  3. Finish the local test with: ./scripts/restore-client.ps1. Do not edit user settings during the test.' }
    if (-not $Local) { Write-Host '  After you restart or sign in to Windows again, run: ./scripts/setup-client.ps1 Start' }
}

function Invoke-Status {
    $problems = [Collections.Generic.List[string]]::new()
    $settings = Read-Settings
    Write-Host 'Copilot Insights client status'
    if ($state) {
        $destination = if ($state.mode -eq 'local') { "local quick start ($LocalEndpoint)" } else { "forwarder on 127.0.0.1:$ForwarderPort -> $($state.endpoint)" }
        Write-Line "Mode:                $destination"
    } else {
        Write-Line 'Mode:                not installed'
        $problems.Add('Copilot Insights is not installed on this machine. Run Install.')
    }
    if ($settings.HasBlock) {
        $blockSettings = $settings.Text | ConvertFrom-Json -AsHashtable
        Write-Line "VS Code settings:    block present in $SettingsPath (endpoint $($blockSettings['github.copilot.chat.otel.otlpEndpoint']))"
    } else {
        Write-Line "VS Code settings:    no Copilot Insights block in $SettingsPath"
        if ($state) { $problems.Add('The settings block is missing. Run Install again.') }
    }
    $telemetryOff = $settings.Parsed['telemetry.telemetryLevel'] -eq 'off' -or $settings.Parsed['telemetry.enableTelemetry'] -eq $false -or (Get-PolicyTelemetryOff)
    Write-Line ('VS Code telemetry:   ' + $(if ($telemetryOff) { 'off (Copilot does not export while it is off)' } else { 'on' }))
    if ($telemetryOff) { $problems.Add('VS Code telemetry is off, so Copilot sends nothing.') }
    $overrides = Get-EnvironmentOverrides
    Write-Line ('Env overrides:       ' + $(if ($overrides) { $overrides -join ', ' } else { 'none' }))
    if ($overrides -and $state.temporary) {
        try { Assert-TemporaryEnvironment; Write-Line 'Temporary setup:    environment flags are compatible with local export and content capture off.' }
        catch { $problems.Add($_.Exception.Message) }
    } elseif ($overrides) { $problems.Add("Environment variables override VS Code settings: $($overrides -join ', ').") }
    $hints = Get-PolicyHints
    Write-Line ('Policy values:       ' + $(if ($hints) { $hints -join ', ' } else { 'none found' }))
    if ($hints) { $problems.Add('Enterprise policy may override these settings.') }

    if ($state -and $state.mode -eq 'local') {
        $healthy = Test-Health $LocalHealthEndpoint
        Write-Line ('Local collector:     ' + $(if ($healthy) { 'reachable' } else { "not reachable at $LocalHealthEndpoint" }))
        if (-not $healthy) { $problems.Add('Start the local collector: docker compose -f deploy/local/compose.yaml up --detach') }
    } elseif ($state) {
        $processes = Get-ForwarderProcess
        $healthy = Test-Health $forwarderHealthUrl
        Write-Line ('Forwarder:           ' + $(if ($healthy) { "running (process $(@($processes.Id) -join ', '))" } else { 'not running' }))
        if (-not $healthy) { $problems.Add('Start the forwarder: ./scripts/setup-client.ps1 Start') }
        $tokenProblem = Get-TokenProblem $state.scope
        Write-Line ('Ingestion token:     ' + $(if ($tokenProblem) { 'not available' } else { 'available from Azure CLI' }))
        if ($tokenProblem) { $problems.Add($tokenProblem) }
        if (Test-Path -LiteralPath $logPath) {
            $recent = @(Get-Content -LiteralPath $logPath -Tail 200 | Where-Object { $_ -match '\t(error|warn)\t' } | Select-Object -Last 3)
            Write-Line ('Recent forwarder:    ' + $(if ($recent) { "$($recent.Count) warning or error line(s), latest below" } else { 'no warnings or errors' }))
            foreach ($line in $recent) { Write-Line ('  ' + $line.Substring(0, [Math]::Min(240, $line.Length))) }
        }
    }

    Write-Host ''
    if ($problems.Count) {
        Write-Host 'Needs attention:'
        foreach ($problem in $problems) { Write-Line "- $problem" }
        exit 1
    }
    Write-Host 'Ready. Telemetry from reloaded VS Code windows can flow.'
}

function Invoke-Uninstall {
    if (Test-Path -LiteralPath $restorePath) { Invoke-Restore; return }
    Write-Host 'Removing Copilot Insights'
    $stopped = Stop-Forwarder
    if ($stopped) { Write-Line 'Stopped the forwarder.' }
    $settings = Read-Settings
    if ($settings.HasBlock -and $PSCmdlet.ShouldProcess($SettingsPath, 'Remove the Copilot Insights settings block')) {
        Write-Settings $settings.WithoutBlock $settings.Bom
        Write-Line "Removed the settings block from $SettingsPath."
    }
    foreach ($name in 'bin', 'config', 'logs', 'backups', 'state.json') {
        $rootPath = [IO.Path]::GetFullPath($InstallRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $path = [IO.Path]::GetFullPath((Join-Path $InstallRoot $name))
        if (-not $path.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to delete a path outside the installation directory.' }
        if ((Test-Path -LiteralPath $path) -and $PSCmdlet.ShouldProcess($path, 'Delete')) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    if ((Test-Path -LiteralPath $InstallRoot) -and -not (Get-ChildItem -LiteralPath $InstallRoot -Force) -and $PSCmdlet.ShouldProcess($InstallRoot, 'Delete')) {
        Remove-Item -LiteralPath $InstallRoot
    }
    Write-Host 'Done. Reload VS Code windows so Copilot stops exporting.'
}

if ($Temporary -and ($Action -ne 'Install' -or -not $Local)) { throw '-Temporary is supported only with Install -Local.' }

switch ($Action) {
    'Install' { Invoke-Install }
    'Start' { Start-Forwarder }
    'Stop' { $count = Stop-Forwarder; Write-Line $(if ($count) { 'Stopped the forwarder.' } else { 'The forwarder was not running.' }) }
    'Status' { Invoke-Status }
    'Uninstall' { Invoke-Uninstall }
    'Restore' { Invoke-Restore }
}
