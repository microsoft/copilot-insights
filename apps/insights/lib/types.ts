// Shared contract between the service and the browser. Keep this file free of runtime imports.

export type Source = 'local' | 'demo';
export type Operation = 'invoke_agent' | 'chat' | 'execute_tool';
export type Outcome = 'ok' | 'error' | 'cancelled' | 'unknown';
export type Priority = 'high' | 'medium' | 'low';
export type ReviewStatus = 'unreviewed' | 'investigating' | 'reviewed' | 'dismissed';
export type FindingKind = 'model-errors' | 'model-latency' | 'token-coverage' | 'unknown-outcomes' | 'stale-data' | 'conflicting-spans';

export interface Span {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sessionId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  operation: Operation;
  startedAt: number | null;
  timestamp: number;
  durationMs: number | null;
  model: string | null;
  tool: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  outcome: Outcome;
  fixtureTagged: boolean;
  projectKey?: string;
  attribution?: string;
}

export interface Feedback {
  name: string;
  timestamp: number;
  conversationId: string | null;
  sessionId: string | null;
  traceId: string | null;
  spanId: string | null;
  projectKey?: string;
  attribution?: string;
}

export interface InputQuality {
  duplicateSpans: number;
  conflictingSpans: number;
  excludedSpans: number;
  metricRecords: number;
  logRecords: number;
  backend?: 'log-analytics';
}

export interface NormalizedTelemetry {
  organizationId: string;
  spans: Span[];
  feedback: Feedback[];
  quality: InputQuality;
}

export interface TelemetryInput extends NormalizedTelemetry {
  pendingRecord: boolean;
  missing: boolean;
  projects?: string[];
}

export interface ModelStats {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  completeTokenCalls: number;
  tokenCoverage: number | null;
  p95Ms: number | null;
  durationCalls: number;
  errors: number;
  unknownOutcomes: number;
}

export interface Breakdown extends ModelStats {
  name: string;
}

export interface TrendPoint extends ModelStats {
  date: string;
}

export interface Review {
  status: ReviewStatus;
  revision: number;
  updatedAt: string | null;
  newEvidence: boolean;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  category: string;
  priority: Priority;
  title: string;
  description: string;
  observed: string;
  rule: string;
  guidance: string;
  evidenceCount: number;
  latestEvidenceAt: number | null;
  evidence: Span[];
  review: Review;
}

export interface TraceGroup {
  traceId: string;
  spans: number;
  linkedChildren: number;
  latestTimestamp: number;
}

export interface InsightsReport {
  schemaVersion: 1;
  source: Source;
  organizationId: string;
  projectKey: string;
  generatedAt: string;
  snapshotId: string;
  window: { days: number; from: string; to: string };
  summary: ModelStats & {
    agentRuns: number;
    nestedAgentRuns: number;
    toolCalls: number;
    errorRate: number | null;
    cancelledCalls: number;
    knownOutcomeCoverage: number | null;
  };
  trend: TrendPoint[];
  models: Breakdown[];
  tools: Breakdown[];
  findings: Finding[];
  correlation: {
    traces: number;
    linkedChildSpans: number;
    spansWithParent: number;
    conversations: number;
    sessions: number;
    spansWithConversationId: number;
    spansWithSessionId: number;
    toolCallsWithId: number;
    feedbackLogs: number;
    matchedFeedbackLogs: number;
    recentTraces: TraceGroup[];
  };
  quality: InputQuality & {
    acceptedSpans: number;
    futureSpans: number;
    attributedSpans: number;
    unattributedSpans: number;
    organizationWideDiagnostics: boolean;
    fixtureTaggedSpans: number;
    pendingRecord: boolean;
    missing: boolean;
    latestTimestamp: string | null;
    stale: boolean;
    smallSample: boolean;
  };
}

export interface Organization {
  id: string;
  name: string;
  source: Source;
}

export interface ProjectEntry {
  id: string;
  name: string;
  project: string | null;
}

export interface Snapshot extends InsightsReport {
  organization: Organization;
  project: ProjectEntry;
}

export interface OrganizationCatalog {
  defaultOrganizationId: string;
  organizations: Organization[];
}

export interface ProjectCatalog {
  organizationId: string;
  projects: ProjectEntry[];
}

export type InsightsResponse = Snapshot & { reviewToken: string };

export interface ErrorResponse {
  error: { code: string; message: string };
}

export type PublicAuthConfig =
  | { mode: 'local' }
  | { mode: 'production'; authority: string; clientId: string; scope: string; redirectUri: string };
