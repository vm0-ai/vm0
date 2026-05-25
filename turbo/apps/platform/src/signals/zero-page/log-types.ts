// API response types (matching app API contracts)
import type {
  LogStatus,
  TriggerSource,
} from "@vm0/api-contracts/contracts/logs";

// Re-export from core contract to stay in sync with the API schema
export type { LogStatus, TriggerSource };

/** Human-readable labels for each trigger source, shared across activity views. */
export const TRIGGER_SOURCE_LABELS: Readonly<Record<TriggerSource, string>> = {
  schedule: "Schedule",
  web: "Web",
  slack: "Slack",
  email: "Email",
  telegram: "Telegram",
  agentphone: "AgentPhone",
  github: "GitHub",
  cli: "CLI",
  agent: "Agent",
};

/**
 * Build a display label for a trigger source.
 * For "agent" sources with a known parent agent name, returns "Agent (name)".
 */
export function getTriggerSourceLabel(
  source: TriggerSource,
  triggerAgentName?: string | null,
): string {
  if (source === "agent" && triggerAgentName) {
    return `Agent (${triggerAgentName})`;
  }
  return TRIGGER_SOURCE_LABELS[source];
}

// List response - contains basic fields for list display
export interface LogEntry {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  displayName: string | null;
  framework: string | null;
  triggerSource: TriggerSource | null;
  triggerAgentName: string | null;
  scheduleId: string | null;
  status: LogStatus;
  prompt: string;
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
  filters: {
    statuses: LogStatus[];
    sources: TriggerSource[];
    agents: string[];
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
  agentId: string | null;
  displayName: string | null;
  framework: string | null;
  modelProvider: string | null;
  selectedModel: string | null;
  triggerSource: TriggerSource | null;
  triggerAgentName: string | null;
  scheduleId: string | null;
  status: LogStatus;
  prompt: string;
  appendSystemPrompt: string | null;
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

// Agent events response from /api/zero/runs/[id]/telemetry/agent
export interface AgentEventsResponse {
  events: AgentEvent[];
  hasMore: boolean;
  framework: string;
}
