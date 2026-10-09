#Requires -Version 7.2
# Tests for scripts/setup-client.ps1. Uses temporary files only: it never reads or changes your VS Code
# settings, starts processes, or needs network access. Run: ./scripts/tests/setup-client.tests.ps1
$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot '..' 'setup-client.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('copilot-insights-tests-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
$failures = 0
# VS Code terminals with Copilot OpenTelemetry enabled inherit exporter variables that temporary setup refuses.
$inheritedTelemetryVariables = @{}
foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys) -match '^(COPILOT_OTEL_|OTEL_)') {
    $inheritedTelemetryVariables[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    Remove-Item -LiteralPath "Env:$name"
}

function Test-Case([string] $name, [scriptblock] $body) {
    try { & $body; Write-Host "PASS  $name" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "FAIL  ${name}: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-That([bool] $condition, [string] $message) { if (-not $condition) { throw $message } }
function New-SettingsCase([AllowNull()] [string] $content, [switch] $Bom) {
    $directory = Join-Path $root ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $directory | Out-Null
    $path = Join-Path $directory 'settings.json'
    if ($null -ne $content) { [IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new([bool]$Bom)) }
    [pscustomobject]@{ Settings = $path; InstallRoot = Join-Path $directory 'install' }
}
function Invoke-Setup($case, [hashtable] $arguments) {
    $arguments = $arguments.Clone()
    $arguments.SettingsPath = $case.Settings
    $arguments.InstallRoot = $case.InstallRoot
    & $setup @arguments *>&1 | Out-String
}
function Get-Bytes($case) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($case.Settings)) }
function Assert-Throws([scriptblock] $body, [string] $pattern) {
    $message = $null
    try { & $body | Out-Null } catch { $message = $_.Exception.Message }
    Assert-That ($null -ne $message) 'Expected an error, but the command succeeded.'
    Assert-That ($message -match $pattern) "Unexpected error: $message"
}

Test-Case 'Install adds a block to a commented CRLF file; Uninstall restores it byte for byte' {
    $case = New-SettingsCase "// my settings`r`n{`r`n`t// editor`r`n`t`"editor.fontSize`": 14,`r`n`t/* trailing comma */ `"files.autoSave`": `"afterDelay`",`r`n}`r`n"
    $before = Get-Bytes $case
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Cohort = 'team-a' } | Out-Null
    $text = Get-Content -Raw -LiteralPath $case.Settings
    $settings = $text | ConvertFrom-Json -AsHashtable
    Assert-That ($settings['github.copilot.chat.otel.enabled'] -eq $true) 'OTel export is not enabled.'
    Assert-That ($settings['github.copilot.chat.otel.otlpEndpoint'] -eq 'http://localhost:4318') 'Unexpected endpoint.'
    Assert-That ($settings['github.copilot.chat.otel.captureContent'] -eq $false) 'Content capture is not off.'
    Assert-That ($settings['github.copilot.chat.otel.captureIdentity'] -eq $false) 'Identity capture is not off.'
    $attributes = $settings['github.copilot.chat.otel.resourceAttributes']
    Assert-That ($attributes['copilot_insights.cohort.id'] -eq 'team-a' -and $attributes['copilot_insights.rollout.ring'] -eq 'local') 'Unexpected resource attributes.'
    Assert-That ($settings['editor.fontSize'] -eq 14 -and $settings['files.autoSave'] -eq 'afterDelay') 'Existing settings changed.'
    Assert-That (-not ($text -match '(?<!\r)\n')) 'Line endings were not preserved.'
    Invoke-Setup $case @{ Action = 'Uninstall' } | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before) 'Uninstall did not restore the original file.'
    Assert-That (-not (Test-Path -LiteralPath $case.InstallRoot)) 'Install directory was not removed.'
}

Test-Case 'Single-line empty object stays valid JSON and is restored' {
    $case = New-SettingsCase '{}'
    Invoke-Setup $case @{ Action = 'Install'; Local = $true } | Out-Null
    $settings = Get-Content -Raw -LiteralPath $case.Settings | ConvertFrom-Json -AsHashtable
    Assert-That ($settings.Count -eq 6) "Expected six settings, found $($settings.Count)."
    Invoke-Setup $case @{ Action = 'Uninstall' } | Out-Null
    Assert-That ((Get-Content -Raw -LiteralPath $case.Settings) -eq '{}') 'File was not restored.'
}

Test-Case 'Missing settings file is created' {
    $case = New-SettingsCase $null
    Invoke-Setup $case @{ Action = 'Install'; Local = $true } | Out-Null
    $settings = Get-Content -Raw -LiteralPath $case.Settings | ConvertFrom-Json -AsHashtable
    Assert-That ($settings['github.copilot.chat.otel.enabled'] -eq $true) 'Settings were not created.'
}

Test-Case 'UTF-8 byte order mark and two-space indentation are preserved' {
    $case = New-SettingsCase "{`n  `"editor.tabSize`": 2`n}`n" -Bom
    $before = Get-Bytes $case
    Invoke-Setup $case @{ Action = 'Install'; Local = $true } | Out-Null
    $bytes = [IO.File]::ReadAllBytes($case.Settings)
    Assert-That ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) 'Byte order mark was removed.'
    Assert-That ((Get-Content -Raw -LiteralPath $case.Settings) -match '\n  "github\.copilot\.chat\.otel\.enabled"') 'Indentation was not matched.'
    Invoke-Setup $case @{ Action = 'Uninstall' } | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before) 'File was not restored.'
}

Test-Case 'Installing again replaces the block instead of adding another' {
    $case = New-SettingsCase "{`n`t`"editor.fontSize`": 14`n}"
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Cohort = 'first' } | Out-Null
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Cohort = 'second' } | Out-Null
    $text = Get-Content -Raw -LiteralPath $case.Settings
    Assert-That (([regex]::Matches($text, '>>> copilot-insights')).Count -eq 1) 'Expected exactly one block.'
    $settings = $text | ConvertFrom-Json -AsHashtable
    Assert-That ($settings['github.copilot.chat.otel.resourceAttributes']['copilot_insights.cohort.id'] -eq 'second') 'Block was not updated.'
}

Test-Case 'Existing Copilot OpenTelemetry settings are left alone' {
    $case = New-SettingsCase "{`n`t`"github.copilot.chat.otel.enabled`": true`n}"
    $before = Get-Bytes $case
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Local = $true } } 'already configure Copilot OpenTelemetry'
    Assert-That ((Get-Bytes $case) -eq $before) 'File changed.'
}

Test-Case 'Telemetry turned off in settings is respected' {
    $case = New-SettingsCase "{`n`t`"telemetry.telemetryLevel`": `"off`"`n}"
    $before = Get-Bytes $case
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Local = $true } } 'telemetry is turned off'
    Assert-That ((Get-Bytes $case) -eq $before) 'File changed.'
}

Test-Case 'Incomplete block markers stop the script' {
    $case = New-SettingsCase "{`n`t/* >>> copilot-insights: managed */`n`t`"editor.fontSize`": 14`n}"
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Local = $true } } 'markers .* are incomplete'
}

Test-Case 'Forwarder endpoints must use HTTPS' {
    $case = New-SettingsCase '{}'
    $before = Get-Bytes $case
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Endpoint = 'http://collector.example.invalid'; Scope = 'api://example/Telemetry.Write' } } 'https://|Windows only'
    Assert-That ((Get-Bytes $case) -eq $before) 'File changed.'
}

Test-Case '-WhatIf changes nothing' {
    $case = New-SettingsCase "{`n`t`"editor.fontSize`": 14`n}"
    $before = Get-Bytes $case
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; WhatIf = $true } | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before) 'File changed.'
    Assert-That (-not (Test-Path -LiteralPath $case.InstallRoot)) 'Install directory was created.'
}

Test-Case 'Status reports the configured block' {
    $case = New-SettingsCase '{}'
    Invoke-Setup $case @{ Action = 'Install'; Local = $true } | Out-Null
    $output = Invoke-Setup $case @{ Action = 'Status' }
    Assert-That ($output -match 'block present') "Status output did not report the block: $output"
    Assert-That ($output -match 'local quick start') 'Status output did not report the mode.'
}

Test-Case 'Temporary local setup restores existing OTel settings, comments, CRLF and BOM byte for byte' {
    $case = New-SettingsCase "// keep this comment`r`n{`r`n  `"github.copilot.chat.otel.enabled`": true,`r`n  `"github.copilot.chat.otel.otlpEndpoint`": `"https://example.invalid`",`r`n  `"github.copilot.chat.otel.headers`": { `"X-Test`": `"not-a-credential`" },`r`n  `"editor.fontSize`": 14,`r`n  `"example.dateString`": `"2026-01-01T00:00:00Z`",`r`n}`r`n" -Bom
    $before = Get-Bytes $case
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } | Out-Null
    $current = Get-Content -Raw -LiteralPath $case.Settings | ConvertFrom-Json -AsHashtable
    Assert-That ($current['github.copilot.chat.otel.otlpEndpoint'] -eq 'http://localhost:4318') 'Not using the local collector.'
    Assert-That (-not $current.Contains('github.copilot.chat.otel.headers')) 'Original exporter headers leaked into the temporary setup.'
    Assert-That ($current['editor.fontSize'] -eq 14) 'An unrelated setting changed.'
    Assert-That ((Get-Content -Raw -LiteralPath $case.Settings) -match '"example.dateString": "2026-01-01T00:00:00Z"') 'A string value was converted into a date.'
    Assert-That ($current['github.copilot.chat.otel.captureContent'] -eq $false -and $current['github.copilot.chat.otel.captureIdentity'] -eq $false) 'Capture privacy flags are not off.'
    & (Join-Path $PSScriptRoot '..' 'restore-client.ps1') -InstallRoot $case.InstallRoot | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before) 'Restoration was not byte for byte.'
    Assert-That (-not (Test-Path -LiteralPath $case.InstallRoot)) 'Sensitive temporary snapshot was not deleted.'
}

Test-Case 'Temporary setup and Restore support missing settings files' {
    $case = New-SettingsCase '{}'
    Remove-Item -LiteralPath $case.Settings
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } | Out-Null
    Invoke-Setup $case @{ Action = 'Restore' } | Out-Null
    Assert-That (-not (Test-Path -LiteralPath $case.Settings)) 'A settings file that did not originally exist was left behind.'
}

Test-Case 'Restore refuses concurrent edits and keeps the original snapshot' {
    $case = New-SettingsCase '{ "github.copilot.chat.otel.enabled": false, "editor.fontSize": 14 }'
    $before = Get-Bytes $case
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } | Out-Null
    $applied = [IO.File]::ReadAllBytes($case.Settings)
    [IO.File]::AppendAllText($case.Settings, "`n// concurrent edit")
    $edited = Get-Bytes $case
    Assert-Throws { Invoke-Setup $case @{ Action = 'Restore' } } 'Refusing to overwrite concurrent edits'
    Assert-That ((Get-Bytes $case) -eq $edited) 'Concurrent settings edits were overwritten.'
    Assert-That (Test-Path -LiteralPath (Join-Path $case.InstallRoot 'local-restore.json')) 'Recovery snapshot was deleted.'
    [IO.File]::WriteAllBytes($case.Settings, $applied)
    Invoke-Setup $case @{ Action = 'Restore' } | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before) 'Recovery after reconciling edits failed.'
}

Test-Case 'Temporary installation cannot overwrite a pending snapshot or an existing installation' {
    $case = New-SettingsCase '{}'
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } | Out-Null
    $before = Get-Bytes $case
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } } 'temporary local setup is active'
    Assert-That ((Get-Bytes $case) -eq $before) 'A pending temporary setup was overwritten.'
    Invoke-Setup $case @{ Action = 'Uninstall' } | Out-Null
    Assert-That ((Get-Content -Raw -LiteralPath $case.Settings) -eq '{}') 'Uninstall did not delegate to Restore.'
    Invoke-Setup $case @{ Action = 'Install'; Local = $true } | Out-Null
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } } 'cannot replace an installed'
    Invoke-Setup $case @{ Action = 'Uninstall' } | Out-Null
}

Test-Case 'Temporary setup still respects disabled telemetry' {
    $case = New-SettingsCase '{ "telemetry.telemetryLevel": "off", "github.copilot.chat.otel.enabled": true }'
    $before = Get-Bytes $case
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } } 'telemetry is turned off'
    Assert-That ((Get-Bytes $case) -eq $before) 'Telemetry opt-out was changed.'
}

Test-Case 'Temporary mode cannot configure a remote endpoint' {
    $case = New-SettingsCase '{}'
    Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Temporary = $true; Endpoint = 'https://example.invalid'; Scope = 'api://example/Telemetry.Write' } } 'only with Install -Local'
    Assert-That (-not (Test-Path -LiteralPath $case.InstallRoot)) 'Invalid temporary setup created state.'
}

Test-Case 'Temporary setup refuses environment routing and content capture overrides' {
    foreach ($name in 'OTEL_EXPORTER_OTLP_ENDPOINT', 'COPILOT_OTEL_CAPTURE_CONTENT') {
        $previous = [Environment]::GetEnvironmentVariable($name, 'Process')
        try {
            [Environment]::SetEnvironmentVariable($name, 'test-override', 'Process')
            $case = New-SettingsCase '{}'
            $before = Get-Bytes $case
            Assert-Throws { Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } } 'cannot verify environment override'
            Assert-That ((Get-Bytes $case) -eq $before) 'Environment override was ignored.'
        } finally {
            if ($null -eq $previous) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable($name, $previous, 'Process') }
        }
    }
}

Test-Case 'Temporary Install and Restore honor WhatIf' {
    $case = New-SettingsCase '{ "github.copilot.chat.otel.enabled": false }'
    $before = Get-Bytes $case
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true; WhatIf = $true } | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before -and -not (Test-Path -LiteralPath $case.InstallRoot)) 'Temporary WhatIf changed files.'
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } | Out-Null
    $applied = Get-Bytes $case
    & (Join-Path $PSScriptRoot '..' 'restore-client.ps1') -InstallRoot $case.InstallRoot -WhatIf | Out-Null
    Assert-That ((Get-Bytes $case) -eq $applied) 'Restore WhatIf changed settings.'
    Invoke-Setup $case @{ Action = 'Restore' } | Out-Null
    Invoke-Setup $case @{ Action = 'Restore' } | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before) 'Restore is not idempotent.'
}

Test-Case 'Restore validates snapshot integrity and the settings path' {
    $case = New-SettingsCase '{}'
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } | Out-Null
    $other = New-SettingsCase '{ "editor.fontSize": 20 }'
    Assert-Throws { & (Join-Path $PSScriptRoot '..' 'restore-client.ps1') -InstallRoot $case.InstallRoot -SettingsPath $other.Settings } 'does not match'
    $snapshotPath = Join-Path $case.InstallRoot 'local-restore.json'
    $snapshotBytes = [IO.File]::ReadAllBytes($snapshotPath)
    $snapshot = Get-Content -LiteralPath $snapshotPath -Raw | ConvertFrom-Json -AsHashtable
    $snapshot.originalSha256 = 'bad-hash'
    Set-Content -LiteralPath $snapshotPath -Value ($snapshot | ConvertTo-Json)
    Assert-Throws { Invoke-Setup $case @{ Action = 'Restore' } } 'integrity check'
    [IO.File]::WriteAllBytes($snapshotPath, $snapshotBytes)
    Invoke-Setup $case @{ Action = 'Restore' } | Out-Null
}

Test-Case 'Restore recovers a custom settings path when setup stops before writing installation state' {
    $case = New-SettingsCase '{ "github.copilot.chat.otel.enabled": true }'
    $before = Get-Bytes $case
    Push-Location (Split-Path -Parent $case.Settings)
    try { & $setup Install -Local -Temporary -SettingsPath './settings.json' -InstallRoot './install' *>&1 | Out-Null }
    finally { Pop-Location }
    Remove-Item -LiteralPath (Join-Path $case.InstallRoot 'state.json')
    & (Join-Path $PSScriptRoot '..' 'restore-client.ps1') -InstallRoot $case.InstallRoot | Out-Null
    Assert-That ((Get-Bytes $case) -eq $before) 'Restore did not recover the settings path from its snapshot.'
}

Test-Case 'Restore safely cleans up a snapshot when the original settings are already back' {
    $case = New-SettingsCase '{}'
    $before = [IO.File]::ReadAllBytes($case.Settings)
    Invoke-Setup $case @{ Action = 'Install'; Local = $true; Temporary = $true } | Out-Null
    [IO.File]::WriteAllBytes($case.Settings, $before)
    Invoke-Setup $case @{ Action = 'Restore' } | Out-Null
    Assert-That (-not (Test-Path -LiteralPath $case.InstallRoot)) 'An already-restored snapshot was left behind.'
}

$resolvedRoot = [IO.Path]::GetFullPath($root)
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
foreach ($name in $inheritedTelemetryVariables.Keys) { [Environment]::SetEnvironmentVariable($name, $inheritedTelemetryVariables[$name], 'Process') }
if (-not $resolvedRoot.StartsWith((Join-Path $temporaryRoot 'copilot-insights-tests-'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected test cleanup path.' }
Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
if ($failures) { Write-Host "$failures test(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'All setup-client tests passed.' -ForegroundColor Green
exit 0
