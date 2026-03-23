// Re-export types from @vm0/core with CLI naming conventions
import type {
  RunResult as CoreRunResult,
  EventsResponse,
  SessionResponse,
  CheckpointResponse,
  ComposeResponse,
  ApiErrorResponse,
  ScheduleResponse,
  ScheduleListResponse,
  DeployScheduleResponse,
  ScheduleRunsResponse,
} from "@vm0/core";

// Re-export types with CLI naming conventions for backward compatibility
export type RunResult = CoreRunResult;
export type ApiError = ApiErrorResponse;
export type GetSessionResponse = SessionResponse;
export type GetCheckpointResponse = CheckpointResponse;
export type GetComposeResponse = ComposeResponse;
export type GetEventsResponse = EventsResponse;

// Re-export @vm0/core types for domain modules
export type {
  ScheduleResponse,
  ScheduleListResponse,
  DeployScheduleResponse,
  ScheduleRunsResponse,
};

// CLI-specific types (not in @vm0/core or have different structure)
export interface CreateComposeResponse {
  composeId: string;
  name: string;
  versionId: string;
  action: "created" | "existing";
  createdAt?: string;
  updatedAt?: string;
}

// RunStatus is inlined here to avoid importing the full type
type RunStatus =
  | "queued"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

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
