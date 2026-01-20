import type {
  RunStatus as CoreRunStatus,
  RunResult as CoreRunResult,
  RunEvent as CoreRunEvent,
  TelemetryMetric as CoreTelemetryMetric,
  NetworkLogEntry as CoreNetworkLogEntry,
  EventsResponse,
  SystemLogResponse,
  MetricsResponse,
  AgentEventsResponse,
  NetworkLogsResponse,
  SessionResponse,
  CheckpointResponse,
  ComposeResponse,
  ScopeResponse as CoreScopeResponse,
  ApiErrorResponse,
} from "@vm0/core";

// Re-export only types that are actually used by CLI consumers
export type RunResult = CoreRunResult;
export type RunEvent = CoreRunEvent;
export type TelemetryMetric = CoreTelemetryMetric;
export type NetworkLogEntry = CoreNetworkLogEntry;
export type { ApiErrorResponse };
export type ScopeResponse = CoreScopeResponse;
export type GetSystemLogResponse = SystemLogResponse;
export type GetMetricsResponse = MetricsResponse;
export type GetAgentEventsResponse = AgentEventsResponse;
export type GetNetworkLogsResponse = NetworkLogsResponse;
export type GetSessionResponse = SessionResponse;
export type GetCheckpointResponse = CheckpointResponse;
export type GetComposeResponse = ComposeResponse;
export type GetEventsResponse = EventsResponse;

// RunStatus is used internally by CreateRunResponse
type RunStatus = CoreRunStatus;

// Usage API types
export interface UsageResponse {
  period: { start: string; end: string };
  summary: { total_runs: number; total_run_time_ms: number };
  daily: Array<{ date: string; run_count: number; run_time_ms: number }>;
}

// CLI-specific types (not in @vm0/core or have different structure)
export interface CreateComposeResponse {
  composeId: string;
  name: string;
  versionId: string;
  action: "created" | "existing";
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateRunResponse {
  runId: string;
  status: RunStatus;
  sandboxId?: string;
  output?: string;
  error?: string;
  executionTimeMs?: number;
  createdAt: string;
}

export interface GetComposeVersionResponse {
  versionId: string;
  tag?: string;
}
