// API response types (matching app API contracts)
import type {
  LogStatus,
  TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import { i18n } from "../../i18n/index.ts";

// Re-export from core contract to stay in sync with the API schema
export type { LogStatus, TriggerSource };

/**
 * Build a display label for a trigger source.
 * For "agent" sources with a known parent agent name, returns "Agent (name)".
 */
export function getTriggerSourceLabel(
  source: TriggerSource,
  triggerAgentName?: string | null,
): string {
  if (source === "agent" && triggerAgentName) {
    return i18n.t(
      ($) => {
        return $.activity.sources.agentWithName;
      },
      { name: triggerAgentName },
    );
  }
  switch (source) {
    case "web": {
      return i18n.t(($) => {
        return $.activity.sources.web;
      });
    }
    case "slack": {
      return i18n.t(($) => {
        return $.activity.sources.slack;
      });
    }
    case "teams": {
      return i18n.t(($) => {
        return $.activity.sources.teams;
      });
    }
    case "feishu": {
      return i18n.t(($) => {
        return $.activity.sources.feishu;
      });
    }
    case "email": {
      return i18n.t(($) => {
        return $.activity.sources.email;
      });
    }
    case "telegram": {
      return i18n.t(($) => {
        return $.activity.sources.telegram;
      });
    }
    case "agentphone": {
      return i18n.t(($) => {
        return $.activity.sources.agentphone;
      });
    }
    case "github": {
      return i18n.t(($) => {
        return $.activity.sources.github;
      });
    }
    case "cli": {
      return i18n.t(($) => {
        return $.activity.sources.cli;
      });
    }
    case "test": {
      return i18n.t(($) => {
        return $.activity.sources.test;
      });
    }
    case "agent": {
      return i18n.t(($) => {
        return $.activity.sources.agent;
      });
    }
    case "webhook": {
      return i18n.t(($) => {
        return $.activity.sources.webhook;
      });
    }
    case "workflow-schedule": {
      return i18n.t(($) => {
        return $.activity.sources.workflowSchedule;
      });
    }
    case "workflow-event": {
      return i18n.t(($) => {
        return $.activity.sources.workflowEvent;
      });
    }
  }
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
  status: LogStatus;
  prompt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
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
  nextCursor?: string | null;
  framework: string;
}
