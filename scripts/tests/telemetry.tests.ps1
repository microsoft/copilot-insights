#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$readTelemetry = Join-Path $PSScriptRoot '..' 'read-telemetry.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('copilot-insights-telemetry-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$path = Join-Path $root 'telemetry.jsonl'
$record = '{"resourceSpans":[],"configVersion":"verify-test"}'
$failures = 0

function Test-Case([string] $name, [scriptblock] $body) {
    try { & $body; Write-Host "PASS  $name" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "FAIL  ${name}: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-That([bool] $condition, [string] $message) { if (-not $condition) { throw $message } }
function Read-Records { @(& $readTelemetry -Path $path -ConfigVersion 'verify-test') }

try {
    Test-Case 'A missing output file yields no records' {
        Assert-That (@(Read-Records).Count -eq 0) 'Missing file should be retried.'
    }

    Test-Case 'An empty output file yields no records' {
        [IO.File]::WriteAllText($path, '')
        Assert-That (@(Read-Records).Count -eq 0) 'Empty file should be retried.'
    }

    Test-Case 'Only complete records for this verification run are read' {
        [IO.File]::WriteAllText($path, "{`"configVersion`":`"another-run`"}`n$record`n")
        $records = @(Read-Records)
        Assert-That ($records.Count -eq 1) 'Expected exactly one matching record.'
        Assert-That ($records[0].configVersion -eq 'verify-test') 'Read another run.'
    }

    Test-Case 'A truncated final record is deferred instead of parsed' {
        [IO.File]::WriteAllText($path, "$record`n{`"configVersion`":`"verify-test`",`"resourceMetrics`":")
        Assert-That (@(Read-Records).Count -eq 1) 'A partial write must not fail or be counted.'
    }

    Test-Case 'A record without its newline is deferred until the next poll' {
        [IO.File]::WriteAllText($path, $record)
        Assert-That (@(Read-Records).Count -eq 0) 'Unterminated record must be deferred.'
        [IO.File]::AppendAllText($path, "`n")
        Assert-That (@(Read-Records).Count -eq 1) 'Completed record was not picked up.'
    }

    Test-Case 'UTF-8 BOM and CRLF records are supported' {
        [IO.File]::WriteAllText($path, "$record`r`n", [Text.UTF8Encoding]::new($true))
        Assert-That (@(Read-Records).Count -eq 1) 'Expected a CRLF record.'
    }

    Test-Case 'Reading while the collector holds the file open tolerates split writes' {
        $writer = [IO.FileStream]::new($path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes("$record`n")
            $writer.Write($bytes, 0, $bytes.Length - 2)
            $writer.Flush()
            Assert-That (@(Read-Records).Count -eq 0) 'An in-progress write must not be parsed.'
            $writer.Write($bytes, $bytes.Length - 2, 2)
            $writer.Flush()
            Assert-That (@(Read-Records).Count -eq 1) 'The completed write was not read.'
        }
        finally { $writer.Dispose() }
    }

    Test-Case 'Malformed complete records still fail verification' {
        [IO.File]::WriteAllText($path, "{`"configVersion`":`"verify-test`",invalid}`n")
        $threw = $false
        try { Read-Records | Out-Null } catch { $threw = $true }
        Assert-That $threw 'Corrupt complete records must not be silently ignored.'
    }
}
finally {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    Remove-Item -LiteralPath $root -Force
}

if ($failures) { Write-Host "$failures test(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'All telemetry reader tests passed.' -ForegroundColor Green
exit 0
