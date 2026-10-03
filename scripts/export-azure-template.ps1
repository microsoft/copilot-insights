#Requires -Version 7.2
[CmdletBinding()]
param([switch] $Check)

$ErrorActionPreference = 'Stop'
$template = Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep'
$output = Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'azuredeploy.json'
$temporary = Join-Path ([IO.Path]::GetTempPath()) "copilot-insights-arm-$([Guid]::NewGuid().ToString('N')).json"
try {
    & az bicep build --file $template --outfile $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Bicep compilation failed.' }
    if ($Check) {
        if (-not (Test-Path -LiteralPath $output)) { throw 'azuredeploy.json is missing. Run scripts/export-azure-template.ps1.' }
        $expected = Get-Content -Raw -LiteralPath $temporary | ConvertFrom-Json -AsHashtable
        $actual = Get-Content -Raw -LiteralPath $output | ConvertFrom-Json -AsHashtable
        $expected.metadata.Remove('_generator')
        $actual.metadata.Remove('_generator')
        if (($expected | ConvertTo-Json -Depth 100 -Compress) -cne ($actual | ConvertTo-Json -Depth 100 -Compress)) {
            throw 'azuredeploy.json is stale. Run scripts/export-azure-template.ps1 and include the generated template.'
        }
        Write-Output 'The Deploy to Azure template matches main.bicep.'
    } else {
        [IO.File]::WriteAllText($output, [IO.File]::ReadAllText($temporary), [Text.UTF8Encoding]::new($false))
        Write-Output 'Updated deploy/azure/azuredeploy.json.'
    }
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
