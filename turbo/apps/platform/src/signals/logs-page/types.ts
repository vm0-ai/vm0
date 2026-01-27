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
  provider: string;
  status: LogStatus;
  prompt: string;
  error: string | null;
  createdAt: string; // ISO timestamp
  startedAt: string | null;
  completedAt: string | null;
  artifact: Artifact;
}
