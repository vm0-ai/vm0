/**
 * Event types emitted by AgentRunner
 */

export interface BaseEvent {
  type: string;
  timestamp: number;
  sessionId?: string;
}

export interface InitEvent extends BaseEvent {
  type: "init";
  content: {
    cwd: string;
    tools: string[];
    model: string;
    sessionId: string;
  };
}

export interface TextEvent extends BaseEvent {
  type: "text";
  content: string;
}

export interface ToolUseEvent extends BaseEvent {
  type: "tool_use";
  tool: string;
  params: Record<string, unknown>;
  toolUseId: string;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  tool: string;
  result: string;
  isError: boolean;
  toolUseId: string;
}

export interface ResultEvent extends BaseEvent {
  type: "result";
  content: {
    success: boolean;
    result: string;
    durationMs: number;
    numTurns: number;
    totalCostUsd: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
    };
  };
}

export type AgentEvent =
  | InitEvent
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent;

export type EventType = AgentEvent["type"];

export type EventCallback<T extends AgentEvent = AgentEvent> = (
  event: T,
) => void;
