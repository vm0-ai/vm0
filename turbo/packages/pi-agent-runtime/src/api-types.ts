import type { PiAgentModelConfig } from "./types";
import type { PiApiFirstTurnOwnership } from "./provider-ownership";

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

export type PiMemoryRecallSelection =
  | {
      readonly status: "no-content";
      readonly memoryStorageId: string;
      readonly storageVersionId: string;
    }
  | {
      readonly status: "ready";
      readonly memoryStorageId: string;
      readonly storageVersionId: string;
      readonly content: string;
      readonly sourceHash: string;
      readonly sourceSize: number;
      readonly tokenCount: number;
    };

export interface PiPreheatedResourceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly agentsFiles: readonly PiPreheatedAgentsFile[];
  readonly skills: readonly PiPreheatedSkill[];
}

export interface PiPreheatedResourceSnapshotV2 {
  readonly schemaVersion: 2;
  readonly agentsFiles: readonly PiPreheatedAgentsFile[];
  readonly skills: readonly PiPreheatedSkill[];
  readonly memoryRecall: PiMemoryRecallSelection;
}

export type PiPreheatedResourceSnapshot =
  | PiPreheatedResourceSnapshotV1
  | PiPreheatedResourceSnapshotV2;

export type PiMemoryRecallOutcomeStatus = "hit" | "miss" | "invalid" | "stale";

export type PiMemoryRecallParity =
  | "frozen-match"
  | "frozen-no-content"
  | "mismatch"
  | "not-applicable";

export interface PiMemoryRecallOutcome {
  readonly mode: "api-first" | "sandbox";
  readonly status: PiMemoryRecallOutcomeStatus;
  readonly parity: PiMemoryRecallParity;
  readonly reason:
    | "empty"
    | "filesystem"
    | "frozen-no-content"
    | "hash-mismatch"
    | "invalid-utf8"
    | "matched"
    | "missing"
    | "non-regular"
    | "oversized"
    | "path-escape"
    | "selection-invalid"
    | "size-mismatch"
    | "symlink"
    | "token-mismatch"
    | "token-overflow"
    | "v1";
  readonly memoryStorageId?: string;
  readonly storageVersionId?: string;
  readonly sourceHash?: string;
  readonly sourceSize?: number;
  readonly injectedTokenCount: number;
}

export type PiMemoryToolOperation = "list" | "search" | "read";

export type PiMemoryToolErrorClass =
  | "aborted"
  | "binary"
  | "invalid-input"
  | "invalid-utf8"
  | "io"
  | "missing"
  | "non-directory"
  | "non-regular"
  | "oversized"
  | "path-race"
  | "symlink"
  | "timeout";

/** Content-free execution-side evidence that one frozen memory source was used. */
export interface PiMemoryToolSourceUse {
  readonly operation: PiMemoryToolOperation;
  readonly outcome: "success" | "error";
  readonly errorClass?: PiMemoryToolErrorClass;
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
  readonly pathHash: string;
  readonly visitedEntries: number;
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly returnedEntries: number;
  readonly returnedLines: number;
  readonly returnedMatches: number;
  readonly truncated: boolean;
  readonly durationMs: number;
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

/** Terminal Responses payload service tier, kept outside persisted Pi state. */
export type PiObservedServiceTier = string | null | undefined;

export interface PiApiFirstTurnArgs {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionId: string;
  readonly sessionJsonl?: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly model: PiAgentModelConfig;
  readonly resourceSnapshot: PiPreheatedResourceSnapshot;
  readonly ownership: PiApiFirstTurnOwnership;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  /**
   * Optional durable gate run immediately before the provider transport.
   * The gate must invoke the marker while it owns its commit boundary.
   */
  readonly providerRequestBoundary?: (
    markProviderRequestMayHaveStarted: () => void,
  ) => Promise<void>;
}

export interface PiApiFirstTurnResult {
  readonly assistantMessage: PiApiAssistantMessage;
  readonly handoffRequired: boolean;
  readonly observedServiceTier: PiObservedServiceTier;
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
