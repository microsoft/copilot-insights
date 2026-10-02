#Requires -Version 7.2
<#
.SYNOPSIS
Sends synthetic Copilot-shaped telemetry to a collector and verifies the privacy pipeline.

.DESCRIPTION
Local mode (default) posts traces, metrics, and logs to the quick-start collector, then inspects the
sanitized output file. The payloads deliberately contain canary values in fields the data contract
excludes; the check fails if any canary reaches the output.

Remote mode (-AccessTokenScope) sends the same payloads to an authenticated deployment using an Azure CLI
access token. Run it from a machine with network access to the private endpoint, then check storage with
the queries printed at the end.
#>
[CmdletBinding()]
param(
    [string] $Endpoint = 'http://localhost:4318',
    [string] $HealthEndpoint = 'http://localhost:13133/',
    [string] $OutputPath = (Join-Path $PSScriptRoot '..' 'deploy' 'local' '.data' 'telemetry.jsonl'),
    [string] $ExpectedOrganizationId = 'local-dev',
    [string] $AccessTokenScope,
    [int] $TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$remote = -not [string]::IsNullOrWhiteSpace($AccessTokenScope)

$runId = [Guid]::NewGuid().ToString('N')
$canary = "CANARY-$runId"
$configVersion = "verify-$runId"
$conversationId = "conv-$runId"
$nowNs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000L

function New-HexId([int] $byteCount) {
    [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes($byteCount)).ToLowerInvariant()
}
function Get-TimeNs([long] $offsetMs) { [string]($nowNs + $offsetMs * 1000000L) }
function New-StringAttribute([string] $key, [string] $value) { @{ key = $key; value = @{ stringValue = $value } } }
function New-IntAttribute([string] $key, [long] $value) { @{ key = $key; value = @{ intValue = [string]$value } } }
function New-BoolAttribute([string] $key, [bool] $value) { @{ key = $key; value = @{ boolValue = $value } } }
function Get-AttributeValue($attributes, [string] $key) {
    $attribute = @($attributes) | Where-Object { $_.key -eq $key } | Select-Object -First 1
    if ($attribute) { $attribute.value } else { $null }
}
function Get-OptionalProperty($object, [string] $name) {
    $property = $object.PSObject.Properties[$name]
    if ($property) { $property.Value } else { $null }
}
function Write-Pass([string] $message) { Write-Host "PASS  $message" -ForegroundColor Green }
function Assert-True([bool] $condition, [string] $message) {
    if (-not $condition) { throw "FAIL  $message" }
    Write-Pass $message
}

$traceId = New-HexId 16
$agentSpanId = New-HexId 8
$chatSpanId = New-HexId 8

$resource = @{
    attributes = @(
        New-StringAttribute 'service.name' 'copilot-chat'
        New-StringAttribute 'service.version' '0.0.0-verification'
        New-StringAttribute 'session.id' "session-$runId"
        New-StringAttribute 'copilot_insights.config.version' $configVersion
        New-StringAttribute 'copilot_insights.organization.id' "$canary-forged-organization"
        New-StringAttribute 'copilot_insights.cohort.id' "$canary;not-an-identifier"
        New-StringAttribute 'host.name' "$canary-host"
        New-StringAttribute 'process.user.name' "$canary-os-user"
    )
}
$scope = @{ name = 'copilot-chat'; version = '0.0.0'; attributes = @(New-StringAttribute 'scope.note' "$canary-scope") }

$traces = @{
    resourceSpans = @(@{
            resource   = $resource
            scopeSpans = @(@{
                    scope = $scope
                    spans = @(
                        @{
                            traceId = $traceId; spanId = $agentSpanId; name = 'invoke_agent copilot'; kind = 1
                            startTimeUnixNano = Get-TimeNs -4000; endTimeUnixNano = Get-TimeNs 0
                            attributes = @(
                                New-StringAttribute 'gen_ai.operation.name' 'invoke_agent'
                                New-StringAttribute 'gen_ai.agent.name' 'copilot'
                                New-StringAttribute 'gen_ai.conversation.id' $conversationId
                                New-StringAttribute 'gen_ai.input.messages' "$canary-prompt"
                                New-StringAttribute 'github.copilot.git.repository' "https://example.invalid/$canary-repository"
                                New-StringAttribute 'github.copilot.git.branch' "$canary-branch"
                                New-StringAttribute 'user.name' "$canary-account"
                            )
                        }
                        @{
                            traceId = $traceId; spanId = $chatSpanId; parentSpanId = $agentSpanId; name = "chat $canary-span-name"; kind = 3
                            startTimeUnixNano = Get-TimeNs -3500; endTimeUnixNano = Get-TimeNs -2500
                            attributes = @(
                                New-StringAttribute 'gen_ai.operation.name' 'chat'
                                New-StringAttribute 'gen_ai.conversation.id' $conversationId
                                New-StringAttribute 'gen_ai.request.model' 'example-model'
                                New-IntAttribute 'gen_ai.usage.input_tokens' 1200
                                New-IntAttribute 'gen_ai.usage.output_tokens' 180
                                New-StringAttribute 'error.type' 'example_error'
                                New-StringAttribute 'gen_ai.output.messages' "$canary-response"
                            )
                            status = @{ code = 2; message = "$canary-status-message" }
                        }
                        @{
                            traceId = $traceId; spanId = (New-HexId 8); parentSpanId = $agentSpanId; name = 'execute_tool readFile'; kind = 1
                            startTimeUnixNano = Get-TimeNs -2400; endTimeUnixNano = Get-TimeNs -2300
                            attributes = @(
                                New-StringAttribute 'gen_ai.operation.name' 'execute_tool'
                                New-StringAttribute 'gen_ai.conversation.id' $conversationId
                                New-StringAttribute 'gen_ai.tool.name' 'readFile'
                                New-StringAttribute 'gen_ai.tool.call.arguments' "{`"path`":`"$canary-arguments`"}"
                                New-StringAttribute 'gen_ai.tool.description' "$canary-tool-description"
                                New-StringAttribute 'github.copilot.tool.parameters.file_path' "C:/$canary/file.txt"
                                New-StringAttribute 'github.copilot.tool.parameters.skill_name' "C:\Users\$canary\skill"
                            )
                            events = @(@{ name = "$canary-event"; timeUnixNano = Get-TimeNs -2350; attributes = @(New-StringAttribute 'exception.message' "$canary-exception") })
                        }
                        @{
                            traceId = $traceId; spanId = (New-HexId 8); parentSpanId = $agentSpanId; name = 'execute_hook PreToolUse'; kind = 1
                            startTimeUnixNano = Get-TimeNs -2200; endTimeUnixNano = Get-TimeNs -2100
                            attributes = @(
                                New-StringAttribute 'gen_ai.operation.name' 'execute_hook'
                                New-StringAttribute 'copilot_chat.hook_command' "$canary-hook-command"
                                New-StringAttribute 'copilot_chat.hook_input' "$canary-hook-input"
                            )
                        }
                    )
                })
        })
}

$metrics = @{
    resourceMetrics = @(@{
            resource     = $resource
            scopeMetrics = @(@{
                    scope   = $scope
                    metrics = @(
                        @{
                            name = 'copilot_chat.tool.call.count'; unit = '{call}'
                            sum  = @{
                                aggregationTemporality = 2; isMonotonic = $true
                                dataPoints = @(@{
                                        asInt = '3'; startTimeUnixNano = Get-TimeNs -60000; timeUnixNano = Get-TimeNs 0
                                        attributes = @(
                                            New-StringAttribute 'gen_ai.tool.name' 'readFile'
                                            New-BoolAttribute 'success' $true
                                            New-StringAttribute 'file.path' "$canary-metric-path"
                                            New-StringAttribute 'server.address' "$canary-server-address"
                                        )
                                    })
                            }
                        }
                        @{
                            name = 'copilot_chat.user.feedback.count'; unit = '{vote}'
                            sum  = @{
                                aggregationTemporality = 2; isMonotonic = $true
                                dataPoints = @(@{
                                        asInt = '1'; startTimeUnixNano = Get-TimeNs -60000; timeUnixNano = Get-TimeNs 0
                                        attributes = @(New-StringAttribute 'rating' 'positive')
                                    })
                            }
                        }
                        @{
                            name = 'example.unapproved.metric'; description = "$canary-metric-description"
                            sum  = @{
                                aggregationTemporality = 2; isMonotonic = $true
                                dataPoints = @(@{ asInt = '1'; startTimeUnixNano = Get-TimeNs -60000; timeUnixNano = Get-TimeNs 0 })
                            }
                        }
                    )
                })
        })
}

$logs = @{
    resourceLogs = @(@{
            resource  = $resource
            scopeLogs = @(@{
                    scope      = $scope
                    logRecords = @(
                        @{
                            timeUnixNano = Get-TimeNs 0; observedTimeUnixNano = Get-TimeNs 0
                            severityNumber = 9; severityText = 'INFO'
                            traceId = $traceId; spanId = $chatSpanId
                            body = @{ stringValue = "$canary-log-body" }
                            attributes = @(
                                New-StringAttribute 'event.name' 'copilot_chat.user.feedback'
                                New-StringAttribute 'rating' 'negative'
                                New-StringAttribute 'participant' "$canary@example.invalid"
                                New-StringAttribute 'gen_ai.conversation.id' $conversationId
                                New-StringAttribute 'gen_ai.input.messages' "$canary-log-prompt"
                            )
                        }
                        @{
                            timeUnixNano = Get-TimeNs 0; observedTimeUnixNano = Get-TimeNs 0
                            severityNumber = 9; severityText = 'INFO'
                            body = @{ stringValue = 'GenAI inference details' }
                            attributes = @(
                                New-StringAttribute 'event.name' 'gen_ai.client.inference.operation.details'
                                New-StringAttribute 'gen_ai.conversation.id' "$canary-unapproved-event"
                            )
                        }
                    )
                })
        })
}

$headers = @{}
if ($remote) {
    $token = az account get-access-token --scope $AccessTokenScope --query accessToken -o tsv
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) { throw 'Could not acquire an access token with Azure CLI.' }
    $headers.Authorization = "Bearer $token"
} elseif ($HealthEndpoint) {
    $healthDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $healthy = $false
        try { $healthy = (Invoke-WebRequest -Uri $HealthEndpoint -SkipHttpErrorCheck -TimeoutSec 5).StatusCode -eq 200 } catch { $healthy = $false }
        if (-not $healthy) { Start-Sleep -Milliseconds 500 }
    } while (-not $healthy -and (Get-Date) -lt $healthDeadline)
    Assert-True $healthy "Collector health endpoint responded ($HealthEndpoint)"
}

$rejectedFields = @{ 'v1/traces' = 'rejectedSpans'; 'v1/metrics' = 'rejectedDataPoints'; 'v1/logs' = 'rejectedLogRecords' }
foreach ($signal in @(@{ Path = 'v1/traces'; Body = $traces }, @{ Path = 'v1/metrics'; Body = $metrics }, @{ Path = 'v1/logs'; Body = $logs })) {
    $uri = '{0}/{1}' -f $Endpoint.TrimEnd('/'), $signal.Path
    $body = $signal.Body | ConvertTo-Json -Depth 32 -Compress
    $response = Invoke-WebRequest -Method Post -Uri $uri -ContentType 'application/json' -Body $body -Headers $headers -SkipHttpErrorCheck -TimeoutSec 30
    if ($response.StatusCode -ne 200) { throw "FAIL  $uri returned HTTP $($response.StatusCode)" }
    $rejected = 0
    if ($response.Content) {
        $partial = Get-OptionalProperty ($response.Content | ConvertFrom-Json) 'partialSuccess'
        if ($partial) { $rejected = [long](Get-OptionalProperty $partial $rejectedFields[$signal.Path]) }
    }
    Assert-True ($rejected -eq 0) "Collector accepted $($signal.Path)"
}

if ($remote) {
    Write-Host ''
    Write-Host "Sent synthetic telemetry for conversation $conversationId."
    Write-Host 'Acceptance does not prove storage. After ingestion delay, run in the Log Analytics workspace:'
    Write-Host "  union AppDependencies, AppRequests | where TimeGenerated > ago(1h) | where tostring(Properties['gen_ai.conversation.id']) == '$conversationId' | project TimeGenerated, Name, Properties"
    Write-Host 'Expect three rows (invoke_agent, chat, execute_tool). Then confirm no canary was stored; expect zero rows:'
    Write-Host "  union withsource=SourceTable App* | where TimeGenerated > ago(1h) | where tostring(pack_all()) has '$canary' | count"
    return
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Milliseconds 500
    $records = @()
    if (Test-Path -LiteralPath $OutputPath) {
        $records = @(Get-Content -LiteralPath $OutputPath | Where-Object { $_.Contains($configVersion) } | ForEach-Object { $_ | ConvertFrom-Json })
    }
    $spanBatches = @($records | Where-Object { Get-OptionalProperty $_ 'resourceSpans' })
    $metricBatches = @($records | Where-Object { Get-OptionalProperty $_ 'resourceMetrics' })
    $logBatches = @($records | Where-Object { Get-OptionalProperty $_ 'resourceLogs' })
} while ((-not $spanBatches -or -not $metricBatches -or -not $logBatches) -and (Get-Date) -lt $deadline)

Assert-True ([bool]$spanBatches -and [bool]$metricBatches -and [bool]$logBatches) "Sanitized traces, metrics, and logs reached $OutputPath"
Assert-True (-not (Select-String -LiteralPath $OutputPath -SimpleMatch $canary -Quiet)) 'No excluded canary value appears in collector output'

$resourceSpans = @($spanBatches | ForEach-Object { $_.resourceSpans } | Where-Object { (Get-AttributeValue $_.resource.attributes 'copilot_insights.config.version').stringValue -eq $configVersion })
$spans = @($resourceSpans | ForEach-Object { $_.scopeSpans } | ForEach-Object { $_.spans })
$names = @($spans | ForEach-Object name | Sort-Object)
Assert-True (($names -join ',') -eq 'chat,execute_tool,invoke_agent') "Approved operations kept with normalized span names ($($names -join ', '))"
Assert-True (-not ($spans | Where-Object { Get-OptionalProperty $_ 'events' })) 'Span events removed'

$chat = $spans | Where-Object name -eq 'chat' | Select-Object -First 1
Assert-True ((Get-AttributeValue $chat.attributes 'gen_ai.usage.input_tokens').intValue -eq '1200') 'Token counts preserved as integers'
Assert-True ((Get-AttributeValue $chat.attributes 'gen_ai.request.model').stringValue -eq 'example-model') 'Model name preserved'
$tool = $spans | Where-Object name -eq 'execute_tool' | Select-Object -First 1
Assert-True ((Get-AttributeValue $tool.attributes 'github.copilot.tool.parameters.skill_name').stringValue -eq 'redacted') 'Path-shaped value in an allowed field replaced with "redacted"'

$allowedResourceKeys = @('service.name', 'service.version', 'session.id', 'copilot_insights.organization.id', 'copilot_insights.cohort.id', 'copilot_insights.config.version', 'copilot_insights.rollout.ring')
$resourceKeys = @($resourceSpans | ForEach-Object { $_.resource.attributes } | ForEach-Object key | Sort-Object -Unique)
Assert-True (-not ($resourceKeys | Where-Object { $_ -notin $allowedResourceKeys })) "Resource keys limited to the allow-list ($($resourceKeys -join ', '))"
$organization = (Get-AttributeValue $resourceSpans[0].resource.attributes 'copilot_insights.organization.id').stringValue
Assert-True ($organization -eq $ExpectedOrganizationId) "Client-supplied organization replaced with configured value '$ExpectedOrganizationId'"
$cohort = (Get-AttributeValue $resourceSpans[0].resource.attributes 'copilot_insights.cohort.id').stringValue
Assert-True ($cohort -eq 'redacted') 'Non-identifier resource value replaced with "redacted"'

$metricList = @($metricBatches | ForEach-Object { $_.resourceMetrics } | ForEach-Object { $_.scopeMetrics } | ForEach-Object { $_.metrics })
$metricNames = @($metricList | ForEach-Object name | Sort-Object -Unique)
Assert-True (($metricNames -join ',') -eq 'copilot_chat.tool.call.count,copilot_chat.user.feedback.count') "Only approved metrics kept ($($metricNames -join ', '))"
$toolPoint = ($metricList | Where-Object name -eq 'copilot_chat.tool.call.count' | Select-Object -First 1).sum.dataPoints[0]
Assert-True ((Get-AttributeValue $toolPoint.attributes 'success').boolValue -eq $true) 'Tool call success dimension preserved'
$feedbackPoint = ($metricList | Where-Object name -eq 'copilot_chat.user.feedback.count' | Select-Object -First 1).sum.dataPoints[0]
Assert-True ((Get-AttributeValue $feedbackPoint.attributes 'rating').stringValue -eq 'positive') 'Feedback rating dimension preserved'

$logRecords = @($logBatches | ForEach-Object { $_.resourceLogs } | ForEach-Object { $_.scopeLogs } | ForEach-Object { $_.logRecords })
$logBodies = @($logRecords | ForEach-Object { $body = Get-OptionalProperty $_ 'body'; if ($body) { Get-OptionalProperty $body 'stringValue' } })
Assert-True ($logRecords.Count -eq 1) "Only approved events kept ($($logRecords.Count) log record)"
Assert-True (-not ($logBodies | Where-Object { $_ })) 'Log bodies cleared'
Assert-True ((Get-AttributeValue $logRecords[0].attributes 'event.name').stringValue -eq 'copilot_chat.user.feedback') 'Feedback event name preserved'
Assert-True ((Get-AttributeValue $logRecords[0].attributes 'rating').stringValue -eq 'negative') 'Feedback event rating preserved'
Assert-True ((Get-AttributeValue $logRecords[0].attributes 'participant').stringValue -eq 'redacted') 'Email-shaped event value replaced with "redacted"'

Write-Host ''
Write-Host "Verification passed (run $runId)." -ForegroundColor Green
