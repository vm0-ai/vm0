// API response types (matching app API contracts)
import type { LogStatus } from "@vm0/core";

// Re-export from core contract to stay in sync with the API schema
export type { LogStatus };

// List response - contains basic fields for list display
export interface LogEntry {
  id: string;
  sessionId: string | null;
  agentName: string;
  displayName: string | null;
  orgSlug: string | null;
  framework: string | null;
  modelProvider: string | null;
  status: LogStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LogsListResponse {
  data: LogEntry[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    totalPages: number;
  };
}

// Detail response - full log information
interface Artifact {
  name: string | null;
  version: string | null;
}

export interface LogDetail {
  id: string;
  sessionId: string | null;
  agentName: string;
  displayName: string | null;
  framework: string | null;
  modelProvider: string | null;
  status: LogStatus;
  prompt: string;
  error: string | null;
  createdAt: string; // ISO timestamp
  startedAt: string | null;
  completedAt: string | null;
  artifact: Artifact;
}

// Agent event from telemetry API
export interface AgentEvent {
  sequenceNumber: number;
  eventType: string;
  eventData: unknown;
  createdAt: string;
}

// Agent events response from /api/agent/runs/[id]/telemetry/agent
export interface AgentEventsResponse {
  events: AgentEvent[];
  hasMore: boolean;
  framework: string;
}
