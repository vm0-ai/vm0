import { runPiApiFirstTurn as runPiApiFirstTurnImpl } from "./api-turn";
import { MemoryPiSession } from "./session-memory";
import type {
  PiApiAssistantContent,
  PiApiAssistantMessage,
  PiApiAssistantStopReason,
  PiApiAssistantTextContent,
  PiApiAssistantToolCallContent,
  PiApiFirstTurnArgs,
  PiApiFirstTurnResult,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
  RunPiApiFirstTurn,
} from "./api-types";
import {
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
} from "./errors";
export { UnsupportedPiResourceSnapshotError, UnsupportedPiSessionVersionError };
export type {
  PiApiAssistantContent,
  PiApiAssistantMessage,
  PiApiAssistantStopReason,
  PiApiAssistantTextContent,
  PiApiAssistantToolCallContent,
  PiApiFirstTurnArgs,
  PiApiFirstTurnResult,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
};

/** Run one provider turn without exposing Pi's native declaration surface. */
export const runPiApiFirstTurn: RunPiApiFirstTurn = runPiApiFirstTurnImpl;

/** Inspect one native Pi JSONL session through a stable structural result. */
export function inspectPiSessionJsonl(jsonl: string): PiSessionInspection {
  const session = MemoryPiSession.fromJsonl(jsonl);
  return {
    sessionId: session.getSessionId(),
    hasPendingToolCalls: session.hasPendingToolCalls(),
    isSettledCheckpoint: session.isSettledCheckpoint(),
  };
}
