#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $SettingsPath,
    [string] $InstallRoot
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'setup-client.ps1') Restore @PSBoundParameters
