#Requires -Version 7.2
# Tests for scripts/setup-client.ps1. Uses temporary files only: it never reads or changes your VS Code
# settings, starts processes, or needs network access. Run: ./scripts/tests/setup-client.tests.ps1
$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot '..' 'setup-client.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('copilot-insights-tests-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
$failures = 0

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

Remove-Item -LiteralPath $root -Recurse -Force
if ($failures) { Write-Host "$failures test(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'All setup-client tests passed.' -ForegroundColor Green
exit 0
