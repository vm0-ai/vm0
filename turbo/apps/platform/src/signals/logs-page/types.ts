// API response types (matching v1 API contract)
export interface LogResponse {
  data: Run[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

export interface Run {
  id: string;
  agent_id: string;
  agent_name: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled";
  prompt: string;
  created_at: string; // ISO timestamp
  started_at: string | null;
  completed_at: string | null;
}
