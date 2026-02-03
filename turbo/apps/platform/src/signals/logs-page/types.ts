// API response types (matching platform API contracts)

// Run status enum for logs
export type LogStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

// List response - contains basic fields for list display
export interface LogEntry {
  id: string;
  agentName: string;
  status: LogStatus;
  createdAt: string;
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
  framework: string | null;
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

// Artifact download URL response
export interface ArtifactDownloadResponse {
  url: string;
  expiresAt: string;
}
