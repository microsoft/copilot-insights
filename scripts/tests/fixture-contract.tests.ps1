#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$verifyScript = Join-Path $PSScriptRoot '..' 'verify.ps1'
$payloads = & $verifyScript -PayloadOnly -Endpoint 'http://127.0.0.1:1' -HealthEndpoint 'http://127.0.0.1:1' -TimeoutSeconds 0
$spans = @($payloads.Traces.resourceSpans[0].scopeSpans[0].spans)
$metrics = @($payloads.Metrics.resourceMetrics[0].scopeMetrics[0].metrics)
$logs = @($payloads.Logs.resourceLogs[0].scopeLogs[0].logRecords)
$failures = 0
$tests = 0

function Test-Case([string] $name, [scriptblock] $body) {
    $script:tests++
    try { & $body; Write-Host "PASS  $name" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "FAIL  ${name}: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-That([bool] $condition, [string] $message) { if (-not $condition) { throw $message } }
function Get-StringAttribute($attributes, [string] $key) {
    $matchingAttributes = @($attributes | Where-Object key -eq $key)
    Assert-That ($matchingAttributes.Count -eq 1 -and $matchingAttributes[0].value.stringValue -is [string]) "Expected one string attribute: $key"
    $matchingAttributes[0].value.stringValue
}
function Get-IntAttribute($attributes, [string] $key) {
    $matchingAttributes = @($attributes | Where-Object key -eq $key)
    Assert-That ($matchingAttributes.Count -eq 1 -and $matchingAttributes[0].value.intValue -is [string] -and $matchingAttributes[0].value.intValue -match '^\d+$') "Expected one OTLP int64 attribute: $key"
    [long]$matchingAttributes[0].value.intValue
}

Test-Case 'Offline mode returns all three OTLP envelopes without a collector' {
    Assert-That (($payloads.PSObject.Properties.Name -join ',') -eq 'Traces,Metrics,Logs') 'Expected trace, metric, and log payloads only.'
    Assert-That ($spans.Count -eq 4 -and $metrics.Count -eq 5 -and $logs.Count -eq 2) 'Fixture signal counts changed; review the documented contract.'
}

Test-Case 'Resources use the documented service and explicit fixture provenance' {
    foreach ($resource in @($payloads.Traces.resourceSpans[0].resource, $payloads.Metrics.resourceMetrics[0].resource, $payloads.Logs.resourceLogs[0].resource)) {
        Assert-That ((Get-StringAttribute $resource.attributes 'service.name') -eq 'copilot-chat') 'Unexpected service name.'
        Assert-That ((Get-StringAttribute $resource.attributes 'service.version') -eq '0.0.0-verification') 'Must not impersonate an installed extension version.'
        Assert-That ((Get-StringAttribute $resource.attributes 'session.id') -match '^session-[a-f0-9]{32}$') 'Expected a fictional window ID.'
        Assert-That ((Get-StringAttribute $resource.attributes 'copilot_insights.config.version') -match '^verify-[a-f0-9]{32}$') 'Missing synthetic provenance.'
    }
}

Test-Case 'Span operation types match the VS Code guide, including the rejected hook' {
    $operations = @($spans | ForEach-Object { Get-StringAttribute $_.attributes 'gen_ai.operation.name' } | Sort-Object)
    Assert-That (($operations -join ',') -eq 'chat,execute_hook,execute_tool,invoke_agent') 'Unexpected span operation.'
    foreach ($span in $spans) {
        $operation = Get-StringAttribute $span.attributes 'gen_ai.operation.name'
        Assert-That ($span.name.StartsWith("$operation ")) 'Input span names should retain their documented operation prefix.'
    }
}

Test-Case 'Span IDs, timestamps, kinds, and parent links use OTLP field types' {
    $agent = $spans | Where-Object name -eq 'invoke_agent copilot'
    foreach ($span in $spans) {
        Assert-That ($span.traceId -match '^[a-f0-9]{32}$' -and $span.spanId -match '^[a-f0-9]{16}$') 'Invalid correlation IDs.'
        Assert-That ($span.startTimeUnixNano -is [string] -and $span.endTimeUnixNano -is [string]) 'OTLP int64 timestamps must be JSON strings.'
        Assert-That ([long]$span.endTimeUnixNano -ge [long]$span.startTimeUnixNano) 'Negative span duration.'
        $operation = Get-StringAttribute $span.attributes 'gen_ai.operation.name'
        Assert-That ($span.kind -eq $(if ($operation -eq 'chat') { 3 } else { 1 })) 'Unexpected span kind.'
        if ($span.spanId -ne $agent.spanId) {
            Assert-That ($span.parentSpanId -eq $agent.spanId -and $span.traceId -eq $agent.traceId) 'Broken agent hierarchy.'
            Assert-That ([long]$span.startTimeUnixNano -ge [long]$agent.startTimeUnixNano -and [long]$span.endTimeUnixNano -le [long]$agent.endTimeUnixNano) 'Child outside the agent interval.'
        }
    }
}

Test-Case 'Parent and model token attributes are integer representations of the same usage' {
    foreach ($span in @($spans | Where-Object { (Get-StringAttribute $_.attributes 'gen_ai.operation.name') -in @('invoke_agent', 'chat') })) {
        Assert-That ((Get-StringAttribute $span.attributes 'gen_ai.provider.name') -eq 'github') 'Unexpected provider.'
        Assert-That ((Get-StringAttribute $span.attributes 'gen_ai.request.model') -eq 'example-model') 'Expected a fictional model.'
        Assert-That ((Get-IntAttribute $span.attributes 'gen_ai.usage.input_tokens') -eq 1200) 'Input token fixture changed.'
        Assert-That ((Get-IntAttribute $span.attributes 'gen_ai.usage.output_tokens') -eq 180) 'Output token fixture changed.'
    }
    $tool = $spans | Where-Object name -eq 'execute_tool readFile'
    Assert-That ((Get-StringAttribute $tool.attributes 'gen_ai.tool.type') -eq 'function') 'Tool type must match the guide.'
    Assert-That ((Get-StringAttribute $tool.attributes 'gen_ai.tool.call.id') -match '^call-[a-f0-9]{32}$') 'Expected a fictional tool-call ID.'
}

Test-Case 'Documented counters are monotonic cumulative OTLP Sums' {
    foreach ($name in @('copilot_chat.tool.call.count', 'copilot_chat.user.feedback.count')) {
        $metric = $metrics | Where-Object name -eq $name
        Assert-That ($null -ne $metric.sum -and $metric.sum.isMonotonic -eq $true -and $metric.sum.aggregationTemporality -eq 2) 'A Counter must not be a gauge or histogram.'
        Assert-That ($metric.sum.dataPoints[0].asInt -is [string] -and [long]$metric.sum.dataPoints[0].asInt -gt 0) 'Expected an integer counter value.'
    }
    $toolPoint = ($metrics | Where-Object name -eq 'copilot_chat.tool.call.count').sum.dataPoints[0]
    $success = @($toolPoint.attributes | Where-Object key -eq 'success')
    Assert-That ($success.Count -eq 1 -and $success[0].value.boolValue -is [bool]) 'Tool success is boolean in the published emitter.'
}

Test-Case 'Documented GenAI measurements use valid Histogram buckets and units' {
    foreach ($definition in @(@{ Name = 'gen_ai.client.operation.duration'; Unit = 's' }, @{ Name = 'gen_ai.client.token.usage'; Unit = '{token}' })) {
        $metric = $metrics | Where-Object name -eq $definition.Name
        Assert-That ($metric.unit -eq $definition.Unit -and $metric.histogram.aggregationTemporality -eq 2) 'Histogram unit or temporality changed.'
        foreach ($point in $metric.histogram.dataPoints) {
            Assert-That ($point.count -is [string] -and $point.count -eq '1' -and $point.sum -is [double]) 'Invalid histogram count or sum type.'
            Assert-That ($point.bucketCounts.Count -eq ($point.explicitBounds.Count + 1)) 'Histogram requires an overflow bucket.'
            Assert-That (([long[]]$point.bucketCounts | Measure-Object -Sum).Sum -eq [long]$point.count) 'Bucket counts do not sum to the observation count.'
            Assert-That ((Get-StringAttribute $point.attributes 'gen_ai.operation.name') -eq 'chat') 'Unexpected metric operation.'
            Assert-That ((Get-StringAttribute $point.attributes 'gen_ai.request.model') -eq 'example-model') 'Unexpected metric model.'
        }
    }
    Assert-That (($metrics | Where-Object name -eq 'gen_ai.client.operation.duration').histogram.dataPoints[0].sum -eq 1.0) 'One second must not be encoded as 1000 seconds.'
}

Test-Case 'Token histogram directions agree with the model attributes' {
    $points = @(($metrics | Where-Object name -eq 'gen_ai.client.token.usage').histogram.dataPoints)
    Assert-That ($points.Count -eq 2) 'Expected separate input and output observations.'
    foreach ($definition in @(@{ Type = 'input'; Tokens = 1200 }, @{ Type = 'output'; Tokens = 180 })) {
        $matching = @($points | Where-Object { (Get-StringAttribute $_.attributes 'gen_ai.token.type') -eq $definition.Type })
        Assert-That ($matching.Count -eq 1 -and $matching[0].sum -eq $definition.Tokens) 'Token direction/value mismatch.'
    }
}

Test-Case 'Events use the published log attribute representation and feedback fields' {
    $names = @($logs | ForEach-Object { Get-StringAttribute $_.attributes 'event.name' } | Sort-Object)
    Assert-That (($names -join ',') -eq 'copilot_chat.user.feedback,gen_ai.client.inference.operation.details') 'Undocumented event name.'
    $feedback = $logs | Where-Object { (Get-StringAttribute $_.attributes 'event.name') -eq 'copilot_chat.user.feedback' }
    Assert-That ((Get-StringAttribute $feedback.attributes 'rating') -eq 'negative') 'Expected a fictional feedback rating.'
    $agent = $spans | Where-Object name -eq 'invoke_agent copilot'
    Assert-That ((Get-StringAttribute $feedback.attributes 'conversation_id') -eq (Get-StringAttribute $agent.attributes 'gen_ai.conversation.id')) 'Feedback must use the emitter conversation_id key.'
}

Test-Case 'Deliberately unsupported controls are identifiable, not claims of client emission' {
    $knownMetrics = @('copilot_chat.tool.call.count', 'copilot_chat.user.feedback.count', 'gen_ai.client.operation.duration', 'gen_ai.client.token.usage')
    $unknown = @($metrics | Where-Object name -notin $knownMetrics)
    Assert-That ($unknown.Count -eq 1 -and $unknown[0].name -eq 'example.unapproved.metric') 'Only the explicit rejected metric may be outside the guide.'
    Assert-That (($payloads | ConvertTo-Json -Depth 32 -Compress).Contains('CANARY-')) 'Privacy-test canaries must remain explicit negative controls.'
}

Test-Case 'OTLP JSON round-tripping preserves integer encodings' {
    $roundTrip = $payloads | ConvertTo-Json -Depth 32 -Compress | ConvertFrom-Json
    $chat = $roundTrip.Traces.resourceSpans[0].scopeSpans[0].spans | Where-Object { (Get-StringAttribute $_.attributes 'gen_ai.operation.name') -eq 'chat' }
    Assert-That ($chat.startTimeUnixNano -is [string]) 'Timestamp encoding changed.'
    Assert-That ((Get-IntAttribute $chat.attributes 'gen_ai.usage.input_tokens') -eq 1200) 'Token encoding changed.'
    $counter = $roundTrip.Metrics.resourceMetrics[0].scopeMetrics[0].metrics | Where-Object name -eq 'copilot_chat.tool.call.count'
    Assert-That ($counter.sum.dataPoints[0].asInt -is [string]) 'Counter int64 encoding changed.'
}

Test-Case 'Separate fixture runs cannot reuse trace identities' {
    $next = & $verifyScript -PayloadOnly
    Assert-That ($next.Traces.resourceSpans[0].scopeSpans[0].spans[0].traceId -ne $spans[0].traceId) 'Each test run needs its own trace ID.'
}

if ($failures) { throw "$failures of $tests verification payload contract tests failed." }
Write-Host "All $tests verification payload contract tests passed." -ForegroundColor Green
