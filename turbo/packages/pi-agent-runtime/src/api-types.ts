import type { PiAgentModelConfig } from "./types";

export interface PiPreheatedAgentsFile {
  readonly path: string;
  readonly content: string;
}

export interface PiPreheatedSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly scope: "user" | "project" | "temporary";
  readonly disableModelInvocation: boolean;
}

export interface PiPreheatedResourceSnapshot {
  readonly schemaVersion: 1;
  readonly agentsFiles: readonly PiPreheatedAgentsFile[];
  readonly skills: readonly PiPreheatedSkill[];
}

export interface PiApiAssistantTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface PiApiAssistantToolCallContent {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type PiApiAssistantContent =
  | PiApiAssistantTextContent
  | PiApiAssistantToolCallContent;

export type PiApiAssistantStopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export interface PiApiAssistantMessage {
  readonly content: readonly PiApiAssistantContent[];
  readonly model: string;
  readonly responseId?: string;
  readonly stopReason: PiApiAssistantStopReason;
  readonly timestamp: number;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

export interface PiApiFirstTurnArgs {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionId: string;
  readonly sessionJsonl?: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly model: PiAgentModelConfig;
  readonly resourceSnapshot: PiPreheatedResourceSnapshot;
}

export interface PiApiFirstTurnResult {
  readonly assistantMessage: PiApiAssistantMessage;
  readonly handoffRequired: boolean;
  readonly sessionJsonl: string;
}

export interface PiSessionInspection {
  readonly sessionId: string;
  readonly messageCount: number;
  readonly hasPendingToolCalls: boolean;
  readonly isSettledCheckpoint: boolean;
}

export type RunPiApiFirstTurn = (
  args: PiApiFirstTurnArgs,
  signal?: AbortSignal,
) => Promise<PiApiFirstTurnResult>;
