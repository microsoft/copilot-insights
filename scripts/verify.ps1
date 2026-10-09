#Requires -Version 7.2
<#
.SYNOPSIS
Sends synthetic Copilot-shaped telemetry to a collector and verifies the privacy pipeline.

.DESCRIPTION
Local mode (default) posts traces, metrics, and logs to the quick-start collector, then inspects the
sanitized output files: spans and logs in -OutputPath, metrics in -MetricsPath. The payloads deliberately contain canary values in fields the data contract
excludes; the check fails if any canary reaches the output.

This script posts OTLP fixtures directly. It never launches VS Code, calls a model, or performs a Copilot
tool invocation. Passing it does not verify emission from a real Copilot process.

Remote mode (-AccessTokenScope) sends the same payloads to an authenticated deployment using an Azure CLI
access token from the explicitly selected -TenantId. Run it from a machine with network access to the private endpoint, then check storage with
the queries printed at the end.

.PARAMETER TenantId
Required for remote delivery. Selects the ingestion tenant without changing the Azure CLI default account.

.PARAMETER PayloadOnly
Return the synthetic OTLP payloads for offline contract tests without contacting a collector or Azure.
The returned payloads include deliberate privacy-test canaries and rejected-record controls.
#>
[CmdletBinding()]
param(
    [string] $Endpoint = 'http://localhost:4318',
    [string] $HealthEndpoint = 'http://localhost:13133/',
    [string] $OutputPath = (Join-Path $PSScriptRoot '..' 'deploy' 'local' '.data' 'vscode-telemetry.jsonl'),
    [string] $MetricsPath = (Join-Path $PSScriptRoot '..' 'deploy' 'local' '.data' 'vscode-metrics.jsonl'),
    [string] $ExpectedOrganizationId = 'local-vscode',
    [string] $AccessTokenScope,
    [string] $TenantId,
    [int] $TimeoutSeconds = 30,
    [switch] $PayloadOnly
)

$ErrorActionPreference = 'Stop'
$remote = -not [string]::IsNullOrWhiteSpace($AccessTokenScope)
if ($remote -and -not $PayloadOnly) {
    $requestedTenant = [Guid]::Empty
    if (-not [Guid]::TryParse($TenantId, [ref]$requestedTenant) -or $requestedTenant -eq [Guid]::Empty) {
        throw 'Remote verification requires an explicit, nonzero -TenantId GUID. The default CLI tenant is not used.'
    }
    $remoteEndpoint = $null
    if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$remoteEndpoint) -or
        $remoteEndpoint.Scheme -ne 'https' -or $remoteEndpoint.UserInfo -or $remoteEndpoint.Query -or $remoteEndpoint.Fragment) {
        throw 'Remote verification requires an HTTPS endpoint without credentials, a query, or a fragment.'
    }
}

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
                                New-StringAttribute 'gen_ai.provider.name' 'github'
                                New-StringAttribute 'gen_ai.agent.name' 'copilot'
                                New-StringAttribute 'gen_ai.request.model' 'example-model'
                                New-IntAttribute 'gen_ai.usage.input_tokens' 1200
                                New-IntAttribute 'gen_ai.usage.output_tokens' 180
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
                                New-StringAttribute 'gen_ai.provider.name' 'github'
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
                                New-StringAttribute 'gen_ai.tool.type' 'function'
                                New-StringAttribute 'gen_ai.tool.call.id' "call-$runId"
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
                            name = 'gen_ai.client.operation.duration'; unit = 's'
                            histogram = @{
                                aggregationTemporality = 2
                                dataPoints = @(@{
                                        count = '1'; sum = 1.0
                                        explicitBounds = @(0.5, 1.0, 5.0); bucketCounts = @('0', '1', '0', '0')
                                        startTimeUnixNano = Get-TimeNs -60000; timeUnixNano = Get-TimeNs 0
                                        attributes = @(
                                            New-StringAttribute 'gen_ai.operation.name' 'chat'
                                            New-StringAttribute 'gen_ai.provider.name' 'github'
                                            New-StringAttribute 'gen_ai.request.model' 'example-model'
                                            New-StringAttribute 'error.type' 'example_error'
                                        )
                                    })
                            }
                        }
                        @{
                            name = 'gen_ai.client.token.usage'; unit = '{token}'
                            histogram = @{
                                aggregationTemporality = 2
                                dataPoints = @(foreach ($tokenType in @('input', 'output')) {
                                        @{
                                            count = '1'; sum = $(if ($tokenType -eq 'input') { 1200.0 } else { 180.0 })
                                            explicitBounds = @(100.0, 1000.0, 10000.0)
                                            bucketCounts = $(if ($tokenType -eq 'input') { @('0', '0', '1', '0') } else { @('0', '1', '0', '0') })
                                            startTimeUnixNano = Get-TimeNs -60000; timeUnixNano = Get-TimeNs 0
                                            attributes = @(
                                                New-StringAttribute 'gen_ai.operation.name' 'chat'
                                                New-StringAttribute 'gen_ai.provider.name' 'github'
                                                New-StringAttribute 'gen_ai.request.model' 'example-model'
                                                New-StringAttribute 'gen_ai.token.type' $tokenType
                                            )
                                        }
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
                                New-StringAttribute 'conversation_id' $conversationId
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

if ($PayloadOnly) {
    return [pscustomobject]@{ Traces = $traces; Metrics = $metrics; Logs = $logs }
}

Write-Host 'Synthetic OTLP fixtures only: no VS Code/Copilot process or model is invoked.'
Write-Host 'Documented signal types plus deliberate privacy-test canaries and rejected-record controls.'

$headers = @{}
if ($remote) {
    $tokenJson = az account get-access-token --tenant $requestedTenant.ToString() --scope $AccessTokenScope --output json
    if ($LASTEXITCODE -ne 0) { throw 'Could not acquire an access token with Azure CLI for the requested tenant.' }
    try { $credential = $tokenJson | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Azure CLI returned an unreadable credential response. No telemetry was sent.' }
    if ($credential.accessToken -isnot [string] -or [string]::IsNullOrWhiteSpace($credential.accessToken) -or
        $credential.tenant -ne $requestedTenant.ToString()) {
        throw 'Azure CLI did not return a credential for the requested tenant. No telemetry was sent.'
    }
    $headers.Authorization = "Bearer $($credential.accessToken)"
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
    $response = Invoke-WebRequest -Method Post -Uri $uri -ContentType 'application/json' -Body $body -Headers $headers -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 30
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
    Write-Host 'Expect three rows (invoke_agent, chat, execute_tool). Check the four fixture metric families and one feedback log too:'
    Write-Host "  AppMetrics | where TimeGenerated > ago(1h) | where tostring(Properties['copilot_insights.config.version']) == '$configVersion' | summarize Records=count() by Name"
    Write-Host "  AppTraces | where TimeGenerated > ago(1h) | where tostring(Properties['copilot_insights.config.version']) == '$configVersion' | project TimeGenerated, Event=tostring(Properties['event.name']), Message"
    Write-Host 'Then confirm no canary was stored; expect zero rows. An empty workspace alone is not a passing privacy check:'
    Write-Host "  union withsource=SourceTable App* | where TimeGenerated > ago(1h) | where tostring(pack_all()) has '$canary' | count"
    return
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Milliseconds 500
    $records = @(& (Join-Path $PSScriptRoot 'read-telemetry.ps1') -Path $OutputPath -ConfigVersion $configVersion)
    $spanBatches = @($records | Where-Object { Get-OptionalProperty $_ 'resourceSpans' })
    $metricBatches = @(& (Join-Path $PSScriptRoot 'read-telemetry.ps1') -Path $MetricsPath -ConfigVersion $configVersion | Where-Object { Get-OptionalProperty $_ 'resourceMetrics' })
    $logBatches = @($records | Where-Object { Get-OptionalProperty $_ 'resourceLogs' })
} while ((-not $spanBatches -or -not $metricBatches -or -not $logBatches) -and (Get-Date) -lt $deadline)

Assert-True ([bool]$spanBatches -and [bool]$logBatches) "Sanitized traces and logs reached $OutputPath"
Assert-True ([bool]$metricBatches) "Sanitized metrics reached $MetricsPath"
Assert-True (-not (Select-String -LiteralPath $OutputPath, $MetricsPath -SimpleMatch $canary -Quiet)) 'No excluded canary value appears in collector output'

$resourceSpans = @($spanBatches | ForEach-Object { $_.resourceSpans } | Where-Object { (Get-AttributeValue $_.resource.attributes 'copilot_insights.config.version').stringValue -eq $configVersion })
$spans = @($resourceSpans | ForEach-Object { $_.scopeSpans } | ForEach-Object { $_.spans })
$names = @($spans | ForEach-Object name | Sort-Object)
Assert-True (($names -join ',') -eq 'chat,execute_tool,invoke_agent') "Approved operations kept with normalized span names ($($names -join ', '))"
Assert-True (-not ($spans | Where-Object { Get-OptionalProperty $_ 'events' })) 'Span events removed'

$chat = $spans | Where-Object name -eq 'chat' | Select-Object -First 1
Assert-True ((Get-AttributeValue $chat.attributes 'gen_ai.usage.input_tokens').intValue -eq '1200') 'Token counts preserved as integers'
Assert-True ((Get-AttributeValue $chat.attributes 'gen_ai.usage.output_tokens').intValue -eq '180') 'Output token counts preserved as integers'
Assert-True ((Get-AttributeValue $chat.attributes 'gen_ai.request.model').stringValue -eq 'example-model') 'Model name preserved'
$modelLatencyMs = ([long]$chat.endTimeUnixNano - [long]$chat.startTimeUnixNano) / 1000000
Assert-True ($modelLatencyMs -eq 1000) 'Model-call latency can be derived from stored timestamps (1000 ms)'
Assert-True ($chat.status.code -eq 2 -and (Get-AttributeValue $chat.attributes 'error.type').stringValue -eq 'example_error') 'Model-call error classification preserved'
$tool = $spans | Where-Object name -eq 'execute_tool' | Select-Object -First 1
$agent = $spans | Where-Object name -eq 'invoke_agent' | Select-Object -First 1
Assert-True ($chat.traceId -eq $agent.traceId -and $tool.traceId -eq $agent.traceId -and $chat.parentSpanId -eq $agent.spanId -and $tool.parentSpanId -eq $agent.spanId) 'Agent, model, and tool spans remain correlated'
Assert-True (-not @($spans | Where-Object { (Get-AttributeValue $_.attributes 'gen_ai.conversation.id').stringValue -ne $conversationId })) 'Conversation ID preserved across agent, model, and tool spans'
Assert-True ((Get-AttributeValue $tool.attributes 'gen_ai.tool.call.id').stringValue -eq "call-$runId") 'Tool-call ID preserved without inventing one'
Assert-True ((Get-AttributeValue $tool.attributes 'github.copilot.tool.parameters.skill_name').stringValue -eq 'redacted') 'Path-shaped value in an allowed field replaced with "redacted"'

$allowedResourceKeys = @('service.name', 'service.version', 'session.id', 'copilot_insights.organization.id', 'copilot_insights.cohort.id', 'copilot_insights.config.version', 'copilot_insights.rollout.ring')
$resourceKeys = @($resourceSpans | ForEach-Object { $_.resource.attributes } | ForEach-Object key | Sort-Object -Unique)
Assert-True (-not ($resourceKeys | Where-Object { $_ -notin $allowedResourceKeys })) "Resource keys limited to the allow-list ($($resourceKeys -join ', '))"
$organization = (Get-AttributeValue $resourceSpans[0].resource.attributes 'copilot_insights.organization.id').stringValue
Assert-True ($organization -eq $ExpectedOrganizationId) "Client-supplied organization replaced with configured value '$ExpectedOrganizationId'"
Assert-True (-not @($resourceSpans | Where-Object { (Get-AttributeValue $_.resource.attributes 'session.id').stringValue -ne "session-$runId" })) 'Client window/session ID preserved on every span resource'
$cohort = (Get-AttributeValue $resourceSpans[0].resource.attributes 'copilot_insights.cohort.id').stringValue
Assert-True ($cohort -eq 'redacted') 'Non-identifier resource value replaced with "redacted"'

$metricList = @($metricBatches | ForEach-Object { $_.resourceMetrics } | ForEach-Object { $_.scopeMetrics } | ForEach-Object { $_.metrics })
$metricNames = @($metricList | ForEach-Object name | Sort-Object -Unique)
Assert-True (($metricNames -join ',') -eq 'copilot_chat.tool.call.count,copilot_chat.user.feedback.count,gen_ai.client.operation.duration,gen_ai.client.token.usage') "Only approved metrics kept ($($metricNames -join ', '))"
$counters = @($metricList | Where-Object name -in @('copilot_chat.tool.call.count', 'copilot_chat.user.feedback.count'))
Assert-True (-not @($counters | Where-Object { $_.sum.isMonotonic -ne $true -or $_.sum.aggregationTemporality -ne 2 })) 'Documented counters retain monotonic cumulative OTLP Sum types'
$toolPoint = ($metricList | Where-Object name -eq 'copilot_chat.tool.call.count' | Select-Object -First 1).sum.dataPoints[0]
Assert-True ((Get-AttributeValue $toolPoint.attributes 'success').boolValue -eq $true) 'Tool call success dimension preserved'
$feedbackPoint = ($metricList | Where-Object name -eq 'copilot_chat.user.feedback.count' | Select-Object -First 1).sum.dataPoints[0]
Assert-True ((Get-AttributeValue $feedbackPoint.attributes 'rating').stringValue -eq 'positive') 'Feedback rating dimension preserved'
$durationMetric = $metricList | Where-Object name -eq 'gen_ai.client.operation.duration' | Select-Object -First 1
Assert-True ($durationMetric.unit -eq 's' -and $durationMetric.histogram.aggregationTemporality -eq 2 -and $durationMetric.histogram.dataPoints[0].count -eq '1' -and $durationMetric.histogram.dataPoints[0].sum -eq 1.0) 'GenAI duration is a histogram in seconds, not milliseconds'
$tokenMetric = $metricList | Where-Object name -eq 'gen_ai.client.token.usage' | Select-Object -First 1
$tokenPoints = @($tokenMetric.histogram.dataPoints)
Assert-True ($tokenMetric.unit -eq '{token}' -and $tokenMetric.histogram.aggregationTemporality -eq 2 -and $tokenPoints.Count -eq 2) 'GenAI token usage is a histogram with separate input and output dimensions'
$inputPoint = $tokenPoints | Where-Object { (Get-AttributeValue $_.attributes 'gen_ai.token.type').stringValue -eq 'input' } | Select-Object -First 1
$outputPoint = $tokenPoints | Where-Object { (Get-AttributeValue $_.attributes 'gen_ai.token.type').stringValue -eq 'output' } | Select-Object -First 1
Assert-True ($inputPoint.count -eq '1' -and $inputPoint.sum -eq 1200 -and $outputPoint.count -eq '1' -and $outputPoint.sum -eq 180) 'Histogram token values match the model span without creating additional model calls'

$logRecords = @($logBatches | ForEach-Object { $_.resourceLogs } | ForEach-Object { $_.scopeLogs } | ForEach-Object { $_.logRecords })
$logBodies = @($logRecords | ForEach-Object { $body = Get-OptionalProperty $_ 'body'; if ($body) { Get-OptionalProperty $body 'stringValue' } })
Assert-True ($logRecords.Count -eq 1) "Only approved events kept ($($logRecords.Count) log record)"
Assert-True (-not ($logBodies | Where-Object { $_ })) 'Log bodies cleared'
Assert-True ((Get-AttributeValue $logRecords[0].attributes 'event.name').stringValue -eq 'copilot_chat.user.feedback') 'Feedback event name preserved'
Assert-True ((Get-AttributeValue $logRecords[0].attributes 'rating').stringValue -eq 'negative') 'Feedback event rating preserved'
Assert-True ((Get-AttributeValue $logRecords[0].attributes 'conversation_id').stringValue -eq $conversationId) 'Feedback correlation uses the published emitter conversation_id attribute'
Assert-True ((Get-AttributeValue $logRecords[0].attributes 'participant').stringValue -eq 'redacted') 'Email-shaped event value replaced with "redacted"'

Write-Host ''
Write-Host "Verification passed (run $runId)." -ForegroundColor Green
Write-Host "Synthetic verification only. Select the portal organization mapped to '$ExpectedOrganizationId' if it is configured; real-client emission remains a separate check."
