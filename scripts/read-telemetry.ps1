#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Path,
    [Parameter(Mandatory)] [string] $ConfigVersion
)

if (-not (Test-Path -LiteralPath $Path)) { return }

$content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
if ($null -eq $content) { return }
$lastNewline = $content.LastIndexOf("`n")
if ($lastNewline -lt 0) { return }

$content.Substring(0, $lastNewline) -split "`n" |
    Where-Object { $_.Contains($ConfigVersion) } |
    ForEach-Object { $_ | ConvertFrom-Json -ErrorAction Stop }
