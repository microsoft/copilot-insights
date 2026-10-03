const byId = (id) => document.getElementById(id);
const number = (value) => value === null ? '—' : new Intl.NumberFormat().format(value);
const compact = (value) => value === null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const percent = (value) => value === null ? '—' : `${(value * 100).toFixed(value === 0 || value === 1 ? 0 : 1)}%`;
const duration = (value) => value === null ? '—' : value < 1000 ? `${number(value)} ms` : `${(value / 1000).toFixed(1)} s`;
const dateTime = (value) => value === null ? 'Not available' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const statuses = { unreviewed: 'Needs review', investigating: 'Investigating', reviewed: 'Reviewed', dismissed: 'Dismissed' };
const priorities = { high: 'High priority', medium: 'Review suggested', low: 'For awareness' };
const views = {
  overview: ['Insights overview', 'A clearer picture of agent activity, with evidence behind every signal.'],
  reviews: ['Human review queue', 'Inspect the evidence. Record a decision. Keep new observations distinct.'],
  models: ['Models & tools', 'Understand observed consumption and execution without double counting.'],
  quality: ['Data quality & coverage', 'Know what is reported, what is missing, and where the boundaries are.'],
};
const parameters = new URLSearchParams(location.search);
const state = {
  source: parameters.get('source') === 'local' ? 'local' : 'demo',
  organizationId: parameters.get('organization'), organizations: [],
  days: [7, 14, 30].includes(Number(parameters.get('days'))) ? Number(parameters.get('days')) : 7,
  view: Object.hasOwn(views, parameters.get('view')) ? parameters.get('view') : 'overview',
  data: null, error: null, reviewStatus: 'all', search: '',
};
let requestController;
let requestVersion = 0;
let toastTimer;
let dialogTrigger;

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svgElement(tag, attributes = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function icon(name) {
  const paths = {
    activity: 'M3 12h4l3-7 4 14 3-7h4',
    tokens: 'M12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
    alert: 'm12 3 10 18H2zM12 9v5M12 17v.2',
    arrow: 'M4 12h15M14 7l5 5-5 5',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6M12 7v.2',
    check: 'm5 12 4 4L19 6',
    external: 'M14 3h7v7M21 3l-11 11M10 5H4v15h15v-6',
    inbox: 'M5 4h14l3 13v3H2v-3zM3 15h5l2 3h4l2-3h5',
  };
  return svgElement('svg', { viewBox: '0 0 24 24', class: 'small-icon', 'aria-hidden': 'true' }, svgElement('path', { d: paths[name] ?? paths.info }));
}

function button(label, action, kind = 'secondary', attributes = {}) {
  return element('button', { type: 'button', class: `button button-${kind}`, onClick: action, ...attributes }, label);
}

function badge(text, className) { return element('span', { class: `pill ${className}` }, text); }
function pending(findings) { return findings.filter((finding) => ['unreviewed', 'investigating'].includes(finding.review.status)); }
function panelHeading(title, subtitle, action = null) {
  return element('div', { class: 'panel-heading' }, element('div', {}, element('h2', {}, title), subtitle && element('p', { class: 'panel-subtitle' }, subtitle)), action);
}

function table(headers, rows, caption, className = '') {
  return element('div', { class: 'table-scroll' }, element('table', { class: className },
    element('caption', { class: 'visually-hidden' }, caption),
    element('thead', {}, element('tr', {}, headers.map((header) => element('th', { scope: 'col', class: header.numeric ? 'numeric' : '' }, header.label)))),
    element('tbody', {}, rows.map((row) => element('tr', {}, row.map((cell, index) => element('td', { class: headers[index]?.numeric ? 'numeric' : '' }, cell))))),
  ));
}

function statCard(label, value, detail, symbol, preciseValue = value) {
  return element('article', { class: 'stat-card', 'aria-label': label },
    element('div', { class: 'stat-header' }, label, element('span', { class: 'stat-icon' }, icon(symbol))),
    element('strong', { class: 'stat-value', title: preciseValue }, value), element('p', { class: 'stat-detail' }, detail),
  );
}

function statsGrid(data) {
  const summary = data.summary;
  return element('div', { class: 'stat-grid' },
    statCard('Agent runs', number(summary.agentRuns), `${number(summary.calls)} model calls · ${number(summary.toolCalls)} tool executions`, 'activity'),
    statCard('Observed tokens', compact(summary.totalTokens), `${compact(summary.inputTokens)} input / ${compact(summary.outputTokens)} output · ${percent(summary.tokenCoverage)} complete`, 'tokens', `${number(summary.totalTokens)} observed tokens`),
    statCard('P95 model latency', duration(summary.p95Ms), `${number(summary.durationCalls)} timed calls${data.quality.smallSample ? ' · Small sample' : ' · Nearest-rank P95'}`, 'clock'),
    statCard('Reported error rate', percent(summary.errorRate), `${number(summary.errors)} errors / ${number(summary.calls)} calls · ${number(summary.unknownOutcomes)} unknown`, 'alert'),
  );
}

function activityChart(data) {
  const width = 720;
  const base = 172;
  const ceiling = Math.max(4, Math.ceil(Math.max(...data.trend.map((point) => point.calls)) / 4) * 4);
  const step = (width - 55) / data.trend.length;
  const chart = svgElement('svg', { viewBox: `0 0 ${width} 205`, class: 'chart', role: 'img', 'aria-label': 'Daily model calls and reported errors. An accessible data table follows.' });
  for (let tick = 0; tick <= 4; tick++) {
    const height = base - tick * 37;
    chart.append(svgElement('line', { x1: 34, x2: 715, y1: height, y2: height, class: 'chart-grid' }));
    chart.append(svgElement('text', { x: 23, y: height + 3, 'text-anchor': 'end' }, number(ceiling * tick / 4)));
  }
  data.trend.forEach((point, index) => {
    const start = 40 + index * step + step * .17;
    const barWidth = step * .66;
    const height = point.calls / ceiling * 148;
    const errorHeight = point.errors / ceiling * 148;
    chart.append(svgElement('rect', { x: start, y: base - height, width: barWidth, height, rx: 3, class: 'chart-bar' }, svgElement('title', {}, `${point.date}: ${point.calls} model calls, including ${point.errors} reported errors`)));
    if (errorHeight) chart.append(svgElement('rect', { x: start, y: base - errorHeight, width: barWidth, height: errorHeight, rx: 2, class: 'chart-error' }));
    if (index % Math.ceil(data.trend.length / 7) === 0 || index === data.trend.length - 1) {
      const label = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${point.date}T00:00:00Z`));
      chart.append(svgElement('text', { x: start + barWidth / 2, y: 194, 'text-anchor': 'middle' }, label));
    }
  });
  const details = element('details', { class: 'chart-data' }, element('summary', {}, 'View activity as a table'),
    table([{ label: 'UTC day' }, { label: 'Model calls', numeric: true }, { label: 'Reported errors', numeric: true }], data.trend.map((point) => [point.date, number(point.calls), number(point.errors)]), 'Daily observed model calls and explicit errors'));
  return element('section', { class: 'panel' }, panelHeading('Agent activity', 'Daily model calls · reported errors are a subset', element('span', { class: 'subtle-label' }, `${state.days} UTC days`)),
    chart, element('div', { class: 'chart-legend' }, element('span', {}, element('i', { class: 'legend-dot' }), 'Model calls'), element('span', {}, element('i', { class: 'legend-dot error' }), 'Reported errors')), details);
}

function reviewFocus(data) {
  const open = data.findings.filter((finding) => finding.review.status === 'unreviewed').length;
  const active = data.findings.filter((finding) => finding.review.status === 'investigating').length;
  const done = data.findings.length - open - active;
  const progress = element('div', { class: 'review-progress', 'aria-hidden': 'true' });
  for (const [className, count] of [['open', open], ['active', active], ['done', done]]) {
    const part = element('span', { class: className });
    part.style.width = `${data.findings.length ? count / data.findings.length * 100 : 0}%`;
    progress.append(part);
  }
  return element('section', { class: 'panel focus-panel' }, panelHeading('Your review focus', 'Rule-based signals, human decisions', icon('check')),
    element('div', { class: 'focus-total' }, element('strong', {}, number(open + active)), element('span', {}, `${open + active === 1 ? 'signal' : 'signals'} awaiting a decision`)),
    progress, element('div', { class: 'review-breakdown' },
      element('div', {}, element('strong', {}, number(open)), 'Needs review'),
      element('div', {}, element('strong', {}, number(active)), 'Investigating'),
      element('div', {}, element('strong', {}, number(done)), 'Decided')),
    button([icon('arrow'), 'Open review queue'], () => changeView('reviews'), 'primary'),
    element('p', { class: 'focus-note' }, 'A signal is a starting point, not a verdict.'),
  );
}

function findingCard(finding) {
  return element('article', { class: 'finding-card' },
    element('div', { class: 'finding-top' }, badge(priorities[finding.priority], `priority-${finding.priority}`), element('span', { class: 'finding-category' }, finding.category)),
    element('h3', {}, finding.title), element('p', {}, finding.description),
    finding.review.status !== 'unreviewed' && element('div', { class: 'finding-state' }, badge(statuses[finding.review.status], `status-${finding.review.status}`)),
    element('div', { class: 'finding-footer' }, element('span', { class: 'evidence-count' }, `${number(finding.evidenceCount)} evidence spans`),
      button(['Review evidence', icon('arrow')], () => openReview(finding), 'link', { 'aria-label': `Review ${finding.title}` })),
  );
}

function coverageRow(label, value) {
  const fill = element('span', { class: `coverage-fill ${value === 1 ? 'good' : ''}` });
  fill.style.width = `${value === null ? 0 : value * 100}%`;
  return element('div', { class: 'coverage-row' }, element('span', {}, label), element('strong', {}, percent(value)), element('div', { class: 'coverage-track', 'aria-hidden': 'true' }, fill));
}

function coveragePanel(data) {
  return element('section', { class: 'panel' }, panelHeading('Collection coverage', 'Unknown is different from zero', button('View data quality', () => changeView('quality'), 'link')),
    element('div', { class: 'coverage-list' },
      coverageRow('Complete token reporting', data.summary.tokenCoverage),
      coverageRow('Explicit model outcomes', data.summary.knownOutcomeCoverage),
      coverageRow('Model duration reporting', data.summary.calls ? data.summary.durationCalls / data.summary.calls : null)),
    element('p', { class: 'coverage-caption' }, 'Reporting coverage is not a success score or a measure of developer productivity.'),
  );
}

function modelName(name, index) { return element('span', { class: 'model-name' }, element('i', { class: `model-dot tone-${index % 4}`, 'aria-hidden': 'true' }), name); }

function modelPreview(data) {
  return element('section', { class: 'panel' }, panelHeading('Model mix', 'Observed calls in this window', button('Explore models', () => changeView('models'), 'link')),
    data.models.length ? table([{ label: 'Model' }, { label: 'Calls', numeric: true }, { label: 'Observed tokens', numeric: true }],
      data.models.slice(0, 4).map((model, index) => [modelName(model.name, index), number(model.calls), number(model.totalTokens)]), 'Model calls and observed tokens')
      : element('p', { class: 'small-note' }, 'No model calls in this window.'),
  );
}

function noData() {
  return element('section', { class: 'empty-state' }, element('div', { class: 'empty-icon' }, icon('inbox')),
    element('h2', {}, 'Your organization is ready for VS Code activity'),
    element('p', {}, 'Enable local OpenTelemetry with setup-client.ps1 Install -Local -Temporary, reload a disposable VS Code window, and ask Local Copilot to read a sample file. Then refresh this organization. Ordinary terminal commands alone do not emit Copilot spans.'),
    element('p', { class: 'small-note' }, 'The demo stays separate. Missing telemetry is never replaced by sample data. Restore your editor settings with restore-client.ps1 after the test.'),
    button('View demo organization', () => changeOrganization('synthetic-demo'), 'primary'),
    button('Check data quality', () => changeView('quality'), 'link'));
}

function renderOverview(data) {
  if (!data.quality.acceptedSpans) return noData();
  const actionable = pending(data.findings);
  return element('div', {}, statsGrid(data), element('div', { class: 'overview-grid' }, activityChart(data), reviewFocus(data)),
    element('div', { class: 'section-heading' }, element('div', {}, element('h2', {}, 'Signals worth a closer look'), element('p', {}, 'Transparent rules surface observations. You decide what they mean.')),
      button(`View ${data.findings.length} ${data.findings.length === 1 ? 'signal' : 'signals'}`, () => changeView('reviews'), 'link')),
    actionable.length ? element('div', { class: 'finding-grid' }, actionable.slice(0, 3).map(findingCard))
      : element('div', { class: 'panel small-note' }, 'No undecided signals in this snapshot. This is not proof that every agent run succeeded.'),
    element('div', { class: 'bottom-grid' }, modelPreview(data), coveragePanel(data)),
  );
}

function renderReviews(data) {
  const results = element('div');
  const resultCount = element('p', { class: 'panel-subtitle', role: 'status' });
  const refreshResults = () => {
    const filtered = data.findings.filter((finding) => (state.reviewStatus === 'all' || finding.review.status === state.reviewStatus)
      && `${finding.title} ${finding.description} ${finding.category}`.toLowerCase().includes(state.search.toLowerCase()));
    resultCount.textContent = `${filtered.length} of ${data.findings.length} signals · Decisions apply to this evidence snapshot`;
    results.replaceChildren(filtered.length ? table([
      { label: 'Signal & evidence' }, { label: 'Priority' }, { label: 'Decision' }, { label: 'Spans', numeric: true }, { label: 'Review', numeric: true },
    ], filtered.map((finding) => [
      element('div', {}, element('span', { class: 'review-title' }, finding.title), element('span', { class: 'review-description' }, finding.description)),
      badge(priorities[finding.priority], `priority-${finding.priority}`),
      element('div', {}, badge(statuses[finding.review.status], `status-${finding.review.status}`), finding.review.updatedAt && element('span', { class: 'review-description' }, `Saved ${dateTime(finding.review.updatedAt)}`)),
      number(finding.evidenceCount),
      button(['Review', icon('arrow')], () => openReview(finding), 'link', { 'aria-label': `Review ${finding.title}` }),
    ]), 'Rule-based signals and local human review decisions', 'review-table') : element('div', { class: 'empty-state' },
      element('div', { class: 'empty-icon' }, icon('check')), element('h2', {}, 'No signals in this view'),
      element('p', {}, 'Try another review status or clear your search. An empty queue does not establish successful task completion.')));
  };
  const search = element('input', { type: 'search', placeholder: 'Search signals…', 'aria-label': 'Search signals', value: state.search,
    onInput: (event) => { state.search = event.target.value; refreshResults(); } });
  const status = element('select', { 'aria-label': 'Filter by review status', onChange: (event) => { state.reviewStatus = event.target.value; refreshResults(); } },
    element('option', { value: 'all', selected: state.reviewStatus === 'all' }, 'All decisions'),
    Object.entries(statuses).map(([value, label]) => element('option', { value, selected: state.reviewStatus === value }, label)));
  refreshResults();
  return element('section', { class: 'panel' }, element('div', { class: 'review-toolbar' }, element('div', {}, element('h2', {}, 'Review queue'), resultCount), element('div', { class: 'review-controls' }, search, status)),
    results, element('p', { class: 'small-note' }, 'Reviewed and dismissed are human workflow decisions, not labels of model correctness. No free-text notes or reviewer identities are stored.'));
}

function renderModels(data) {
  if (!data.models.length && !data.tools.length) return noData();
  return element('div', { class: 'section-stack' },
    element('section', { class: 'panel' }, panelHeading('Model consumption & reliability', `${number(data.summary.calls)} canonical model spans in this window`, element('span', { class: 'subtle-label' }, 'Span-derived')),
      table([{ label: 'Model' }, { label: 'Calls', numeric: true }, { label: 'Observed tokens', numeric: true }, { label: 'P95 latency', numeric: true }, { label: 'Errors', numeric: true }, { label: 'Token coverage', numeric: true }],
        data.models.map((model, index) => [modelName(model.name, index), number(model.calls), number(model.totalTokens), duration(model.p95Ms), number(model.errors), percent(model.tokenCoverage)]), 'Model consumption, latency, explicit errors, and reporting coverage', 'wide-table'),
      element('p', { class: 'small-note' }, 'Observed tokens include only reported input and output counts on model spans. Missing counts are unknown; parent-agent totals are not added. No pricing, savings, or productivity estimates are inferred.')),
    element('section', { class: 'panel' }, panelHeading('Tool executions', 'Executed spans, not tool definitions or cumulative counters', element('span', { class: 'subtle-label' }, 'No double counting')),
      table([{ label: 'Tool' }, { label: 'Executions', numeric: true }, { label: 'P95 latency', numeric: true }, { label: 'Reported errors', numeric: true }, { label: 'Unknown outcomes', numeric: true }],
        data.tools.map((tool, index) => [modelName(tool.name, index), number(tool.calls), duration(tool.p95Ms), number(tool.errors), number(tool.unknownOutcomes)]), 'Actual tool execution spans', 'wide-table'),
      element('p', { class: 'small-note' }, 'Metric and feedback records are not added to these counts. Runtime metrics have independent temporality, and feedback needs a separately qualified identity contract.')),
  );
}

function facts(entries) {
  return element('dl', { class: 'fact-list' }, entries.flatMap(([label, value]) => [element('dt', {}, label), element('dd', {}, value)]));
}

function renderQuality(data) {
  const quality = data.quality;
  const tile = (label, value, description) => element('article', { class: 'quality-tile' }, element('h3', {}, label), element('strong', {}, value), element('p', {}, description));
  return element('div', { class: 'section-stack' },
    element('div', { class: 'quality-grid' },
      tile('Complete token reporting', percent(data.summary.tokenCoverage), `${number(data.summary.completeTokenCalls)} of ${number(data.summary.calls)} model calls report both token counts. Partial totals stay labeled as observed.`),
      tile('Explicit model outcomes', percent(data.summary.knownOutcomeCoverage), `${number(data.summary.unknownOutcomes)} unknown outcomes and ${number(data.summary.cancelledCalls)} cancellations. Absence of errors is not success.`)),
    element('div', { class: 'bottom-grid' },
      element('section', { class: 'panel' }, panelHeading('Source & freshness', 'A snapshot, not a live-service guarantee'), facts([
        ['Organization', data.organization.name],
        ['Organization ID', data.organizationId],
        ['Source', data.source === 'demo' ? 'Isolated synthetic generator' : 'Read-only local collector'],
        ['Latest accepted span', dateTime(quality.latestTimestamp)],
        ['Freshness', data.source === 'demo' ? 'Demonstration, not live usage' : quality.latestTimestamp === null ? 'No accepted data' : quality.stale ? 'Older than 15 minutes' : 'Within 15 minutes'],
        ['Selected window', `${data.window.from.slice(0, 10)} – ${data.window.to.slice(0, 10)} (UTC)`],
        ['Accepted spans in window', number(quality.acceptedSpans)],
        ['Verification-tagged spans', number(quality.fixtureTaggedSpans)],
        ['Input file present', data.source === 'demo' ? 'Not used' : quality.missing ? 'No' : 'Yes'],
      ])),
      element('section', { class: 'panel' }, panelHeading('Replay & input handling', 'File-wide diagnostics, not windowed activity totals'), facts([
        ['Identical replayed spans', number(quality.duplicateSpans)],
        ['Conflicting identities excluded', number(quality.conflictingSpans)],
        ['Unsupported or invalid spans excluded', number(quality.excludedSpans)],
        ['Future spans excluded', number(quality.futureSpans)],
        ['Incomplete final record', quality.pendingRecord ? 'Deferred until the next refresh' : 'None'],
        ['Metric records (not summed)', number(quality.metricRecords)],
        ['Log records (not counted as calls)', number(quality.logRecords)],
      ]))),
    element('section', { class: 'panel' }, panelHeading('Correlation within this organization', 'IDs come from the client; the collector assigns the organization'), facts([
      ['Distinct trace IDs', number(data.correlation.traces)],
      ['Child spans linked to a parent in this window', `${number(data.correlation.linkedChildSpans)} of ${number(data.correlation.spansWithParent)}`],
      ['Conversation IDs', `${number(data.correlation.conversations)} across ${number(data.correlation.spansWithConversationId)} spans`],
      ['Window/session IDs', `${number(data.correlation.sessions)} across ${number(data.correlation.spansWithSessionId)} spans`],
      ['Tool spans with a tool-call ID', number(data.correlation.toolCallsWithId)],
      ['Feedback logs linked to spans in this window', `${number(data.correlation.matchedFeedbackLogs)} of ${number(data.correlation.feedbackLogs)}`],
    ]), element('p', { class: 'small-note' }, 'A conversation can span several traces. Feedback without a trace ID joins by conversation ID and, when present, window/session ID. Missing parents can be outside this window. Sessions are not users; metric aggregates are not per-call joins.'),
      data.correlation.recentTraces.length ? table([{ label: 'Recent trace ID' }, { label: 'Spans', numeric: true }, { label: 'Linked children', numeric: true }], data.correlation.recentTraces.map((trace) => [
        data.source === 'local' ? element('a', { href: `http://127.0.0.1:18888/traces/detail/${trace.traceId}`, target: '_blank', rel: 'noreferrer' }, element('code', {}, trace.traceId)) : element('code', {}, trace.traceId),
        number(trace.spans), number(trace.linkedChildren),
      ]), 'Recent traces in the selected organization') : element('p', { class: 'small-note' }, 'No trace IDs reported yet.')),
    element('section', { class: 'panel' }, panelHeading('How to read these insights', 'Public, deterministic rules rather than generated conclusions'),
      element('ul', { class: 'policy-list' },
        element('li', {}, 'Counts use one canonical representation per operation. Exact replays are deduplicated by collector organization, service/scope, trace ID, and span ID; conflicting identities are excluded.'),
        element('li', {}, 'Tokens are observed consumption only. P95 is nearest-rank across reported model durations. The 5-second latency and 15-minute freshness thresholds are evaluation defaults, not production SLOs.'),
        element('li', {}, 'Model errors, cancellations, OK statuses, and unknown outcomes remain distinct. None is proof of task completion or individual productivity.'),
        element('li', {}, 'Review decisions belong to the selected organization, UTC window, and exact evidence snapshot. New evidence or another organization cannot inherit a previous approval.'),
        element('li', {}, 'This local file adapter is not an authorized cloud query service. It does not complete real-client, privacy, Azure, or shared-access qualification.'))),
  );
}

function spanCorrelation(span, source) {
  return element('details', { class: 'correlation-details' }, element('summary', {}, 'IDs & trace'), facts([
    ['Trace ID', span.traceId], ['Span ID', span.spanId], ['Parent span ID', span.parentSpanId ?? 'Not reported'],
    ['Conversation ID', span.conversationId ?? 'Not reported'], ['Window/session ID', span.sessionId ?? 'Not reported'],
    ['Tool-call ID', span.toolCallId ?? 'Not reported'],
  ]), source === 'local' ? element('a', { href: `http://127.0.0.1:18888/traces/detail/${span.traceId}`, target: '_blank', rel: 'noreferrer' }, 'Open trace in Aspire') : 'Synthetic trace; not sent to a collector');
}

function openReview(finding) {
  dialogTrigger = document.activeElement;
  const dialog = byId('review-dialog');
  const data = state.data;
  const close = button('×', () => dialog.close(), 'quiet', { class: 'close-button', 'aria-label': 'Close evidence review' });
  const sourceLabel = `${data.organization.name} · ${data.source === 'demo' ? 'Synthetic example, not real usage' : 'Local collector snapshot'}`;
  const evidenceRows = finding.evidence.map((span) => [
    element('span', { class: 'evidence-time' }, dateTime(span.timestamp)),
    element('div', {}, span.model ?? span.tool ?? span.operation, element('span', { class: 'review-description' }, span.operation)),
    `${number(span.inputTokens)} / ${number(span.outputTokens)}`,
    duration(span.durationMs),
    element('span', { class: `outcome-${span.outcome}` }, { error: 'Error', unknown: 'Unknown', cancelled: 'Cancelled', ok: 'OK' }[span.outcome]),
    spanCorrelation(span, data.source),
  ]);
  const decision = element('select', { id: 'review-decision' }, Object.entries(statuses).map(([value, label]) => element('option', { value, selected: finding.review.status === value }, label)));
  const errorArea = element('div', { role: 'alert' });
  const save = button('Save decision', async () => {
    save.disabled = true;
    decision.disabled = true;
    errorArea.replaceChildren();
    try {
      const response = await fetch('/api/reviews', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': data.reviewToken },
        body: JSON.stringify({ organizationId: data.organizationId, days: data.window.days, findingId: finding.id, status: decision.value, expectedRevision: finding.review.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'The decision could not be saved.');
      finding.review = result.review;
      if (dialog.open) dialog.close();
      render();
      notify(`Decision saved locally: ${statuses[result.review.status]}.`);
    } catch (error) {
      errorArea.replaceChildren(element('p', { class: 'inline-error' }, error.message), button('Refresh evidence', () => { dialog.close(); loadData(); }, 'link'));
    } finally {
      save.disabled = false;
      decision.disabled = false;
    }
  }, 'primary');
  dialog.replaceChildren(
    element('div', { class: 'dialog-header' }, element('div', {}, element('div', { class: 'eyebrow' }, 'EVIDENCE REVIEW'), element('h2', { id: 'review-title', tabindex: '-1' }, finding.title)), close),
    element('div', { class: 'dialog-body' },
      element('div', { class: 'dialog-pills' }, badge(priorities[finding.priority], `priority-${finding.priority}`), badge(finding.category, 'priority-low'), badge(statuses[finding.review.status], `status-${finding.review.status}`)),
      element('p', {}, finding.description),
      element('div', { class: 'observed-value' }, element('span', {}, 'Observed in this snapshot'), element('strong', {}, finding.observed)),
      element('div', { class: 'rule-block' }, element('h3', {}, 'Why it surfaced'), element('p', {}, finding.rule)),
      element('h3', {}, 'Supporting evidence'),
      element('p', { class: 'small-note' }, `${sourceLabel}. Showing ${finding.evidence.length} of ${finding.evidenceCount} matching spans.${finding.kind === 'stale-data' ? ' Freshness evidence can be outside the selected window.' : ''}`),
      evidenceRows.length ? table([{ label: 'Time (local)' }, { label: 'Operation' }, { label: 'In / out tokens', numeric: true }, { label: 'Duration', numeric: true }, { label: 'Outcome' }, { label: 'Trace' }], evidenceRows, 'Sanitized evidence spans supporting this finding', 'evidence-table')
        : element('p', { class: 'small-note' }, 'This finding concerns excluded records. Raw conflicting data is intentionally not exposed.'),
      element('div', { class: 'review-guidance' }, element('h3', {}, 'Before you decide'), element('p', {}, finding.guidance)),
      element('p', { class: 'small-note' }, `Evidence fingerprint ${finding.id}. Missing values are shown as —. Trace links open the separate local Aspire diagnostics view; synthetic demo spans have no collector trace.`)),
    element('div', { class: 'dialog-footer' }, element('div', { class: 'decision-controls' }, element('label', { class: 'decision-field', for: 'review-decision' }, 'Your review decision', decision), save),
      element('p', { class: 'decision-note' }, 'Saved on this machine only. No free-text notes, identities, or external uploads.'), errorArea),
  );
  dialog.showModal();
  byId('review-title').focus();
}

function updateChrome() {
  byId('page-title').textContent = views[state.view][0];
  byId('page-description').textContent = views[state.view][1];
  byId('organization-selector').value = state.organizationId ?? '';
  byId('organization-selector').disabled = !state.organizations.length;
  document.querySelectorAll('[data-days]').forEach((node) => node.setAttribute('aria-pressed', String(Number(node.dataset.days) === state.days)));
  document.querySelectorAll('[data-view]').forEach((node) => {
    const selected = node.dataset.view === state.view;
    node.setAttribute('aria-selected', String(selected));
    node.tabIndex = selected ? 0 : -1;
  });
  byId('view-panel').setAttribute('aria-labelledby', `tab-${state.view}`);
  if (state.organizationId) {
    const query = new URLSearchParams({ organization: state.organizationId, days: String(state.days), view: state.view });
    history.replaceState(null, '', `/?${query}`);
  }
  const notice = byId('source-notice');
  notice.className = `source-notice${state.source === 'demo' ? ' notice-demo' : ''}`;
  notice.replaceChildren(icon('info'), element('span', {},
    element('span', { class: 'notice-label' }, `${state.organizations.find((entry) => entry.id === state.organizationId)?.name ?? 'Loading organization'}: `),
    state.source === 'demo' ? 'Fictional sample data, ready to explore. Next, enable VS Code logging and switch to your local organization. Data and decisions stay separate.'
      : state.data?.quality.fixtureTaggedSpans ? 'Verification fixtures are present. Sample activity is not real-user usage.'
        : 'Only the narrow metadata projection is displayed. No source data is sent to external services.'));
  byId('review-count').textContent = state.data ? number(pending(state.data.findings).length) : '—';
  byId('updated-at').textContent = state.data ? `Snapshot refreshed ${dateTime(state.data.generatedAt)} · Local only` : 'No external analytics or tracking';
}

function render() {
  updateChrome();
  const panel = byId('view-panel');
  if (state.error) {
    panel.replaceChildren(element('div', { class: 'empty-state error-state', role: 'alert' }, element('div', { class: 'empty-icon' }, icon('alert')), element('h2', {}, 'Insights are temporarily unavailable'),
      element('p', {}, state.error), element('p', {}, 'No cached or substitute data is displayed.'), button('Try again', loadData, 'primary')));
  } else if (!state.data) {
    panel.replaceChildren(element('div', { class: 'loading-state', role: 'status' }, 'Reading a fresh local snapshot…'));
  } else {
    const renderers = { overview: renderOverview, reviews: renderReviews, models: renderModels, quality: renderQuality };
    panel.replaceChildren(renderers[state.view](state.data));
  }
}

function changeView(view) {
  state.view = view;
  render();
}

function changeOrganization(organizationId) {
  state.organizationId = organizationId;
  state.source = state.organizations.find((entry) => entry.id === organizationId)?.source;
  state.search = '';
  state.reviewStatus = 'all';
  loadData();
}

async function loadData() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  const version = ++requestVersion;
  state.data = null;
  state.error = null;
  byId('refresh-button').disabled = true;
  byId('view-panel').setAttribute('aria-busy', 'true');
  render();
  try {
    if (!state.organizations.length) {
      const catalogResponse = await fetch('/api/organizations', { signal: controller.signal });
      const catalog = await catalogResponse.json();
      if (!catalogResponse.ok || !Array.isArray(catalog.organizations)) throw new Error('The organization catalog is unavailable. No substitute data is shown.');
      if (version !== requestVersion) return;
      state.organizations = catalog.organizations;
      byId('organization-selector').replaceChildren(...catalog.organizations.map((entry) => element('option', { value: entry.id }, entry.name)));
      if (!state.organizationId) {
        const legacySource = parameters.get('source');
        state.organizationId = legacySource ? catalog.organizations.find((entry) => entry.source === legacySource)?.id : catalog.defaultOrganizationId;
      }
    }
    const selected = state.organizations.find((entry) => entry.id === state.organizationId);
    if (!selected) throw new Error('This organization is not configured. Choose an organization from the list.');
    state.source = selected.source;
    const query = new URLSearchParams({ organization: state.organizationId, days: String(state.days) });
    const response = await fetch(`/api/insights?${query}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'The local insights service could not return a snapshot.');
    if (data.schemaVersion !== 1 || data.source !== state.source || data.organizationId !== state.organizationId) throw new Error('The snapshot organization or schema is not supported.');
    if (version !== requestVersion) return;
    state.data = data;
  } catch (error) {
    if (error.name === 'AbortError' || version !== requestVersion) return;
    state.error = error.message;
  } finally {
    if (version === requestVersion) {
      byId('refresh-button').disabled = false;
      byId('view-panel').setAttribute('aria-busy', 'false');
      render();
    }
  }
}

function notify(message) {
  clearTimeout(toastTimer);
  byId('toast').textContent = message;
  toastTimer = setTimeout(() => { byId('toast').textContent = ''; }, 5000);
}

byId('organization-selector').addEventListener('change', (event) => changeOrganization(event.target.value));
byId('refresh-button').addEventListener('click', loadData);
document.querySelectorAll('[data-days]').forEach((node) => node.addEventListener('click', () => { state.days = Number(node.dataset.days); loadData(); }));
const tabs = [...document.querySelectorAll('[data-view]')];
tabs.forEach((node, index) => {
  node.addEventListener('click', () => changeView(node.dataset.view));
  node.addEventListener('keydown', (event) => {
    let target;
    if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') target = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === 'Home') target = tabs[0];
    if (event.key === 'End') target = tabs[tabs.length - 1];
    if (target) { event.preventDefault(); changeView(target.dataset.view); target.focus(); }
  });
});
byId('review-dialog').addEventListener('close', () => {
  queueMicrotask(() => {
    const replacement = [...document.querySelectorAll('button[aria-label]')].find((node) => node.getAttribute('aria-label') === dialogTrigger?.getAttribute('aria-label'));
    (dialogTrigger?.isConnected ? dialogTrigger : replacement ?? byId(`tab-${state.view}`)).focus();
  });
});
byId('policy-button').addEventListener('click', () => { byId('policy-dialog').showModal(); byId('policy-title').focus(); });
byId('close-policy').addEventListener('click', () => byId('policy-dialog').close());
byId('policy-dialog').addEventListener('close', () => byId('policy-button').focus());
for (const dialogId of ['review-dialog', 'policy-dialog']) {
  const dialog = byId(dialogId);
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
  });
}
loadData();
