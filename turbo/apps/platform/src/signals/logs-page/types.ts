// API response types (matching platform API contracts)

// List response - only contains IDs for efficiency
interface LogEntry {
  id: string;
}

export interface LogsListResponse {
  data: LogEntry[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

// Detail response - full log information
export type LogStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

interface Artifact {
  name: string | null;
  version: string | null;
}

export interface LogDetail {
  id: string;
  sessionId: string | null;
  agentName: string;
  provider: string | null;
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
