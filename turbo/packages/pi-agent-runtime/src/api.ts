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
  PiObservedServiceTier,
  PiMemoryRecallOutcome,
  PiMemoryRecallOutcomeStatus,
  PiMemoryRecallParity,
  PiMemoryRecallSelection,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
  RunPiApiFirstTurn,
} from "./api-types";
import {
  PiApiFirstTurnCompactionRequiredError,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
} from "./errors";
import { createPiApiFirstTurnOwnership } from "./provider-ownership";
import type {
  PiApiFirstTurnOwnership,
  PiApiFirstTurnOwnershipStage,
} from "./provider-ownership";
export {
  PiApiFirstTurnCompactionRequiredError,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
};
export { createPiApiFirstTurnOwnership };
export type {
  PiApiAssistantContent,
  PiApiAssistantMessage,
  PiApiAssistantStopReason,
  PiApiAssistantTextContent,
  PiApiAssistantToolCallContent,
  PiApiFirstTurnArgs,
  PiApiFirstTurnResult,
  PiObservedServiceTier,
  PiMemoryRecallOutcome,
  PiMemoryRecallOutcomeStatus,
  PiMemoryRecallParity,
  PiMemoryRecallSelection,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
  PiApiFirstTurnOwnership,
  PiApiFirstTurnOwnershipStage,
};

/** Run one provider turn without exposing Pi's native declaration surface. */
export const runPiApiFirstTurn: RunPiApiFirstTurn = runPiApiFirstTurnImpl;

/** Create the canonical empty native Pi history for a new API-first launch. */
export function createPiSessionJsonl(args: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly timestamp: string;
}): string {
  return MemoryPiSession.create({
    cwd: args.cwd,
    id: args.sessionId,
    timestamp: args.timestamp,
  }).toJsonl();
}

/** Inspect one native Pi JSONL session through a stable structural result. */
export function inspectPiSessionJsonl(jsonl: string): PiSessionInspection {
  const session = MemoryPiSession.fromJsonl(jsonl);
  return {
    sessionId: session.getSessionId(),
    messageCount: session.buildSessionContext().messages.length,
    hasPendingToolCalls: session.hasPendingToolCalls(),
    isSettledCheckpoint: session.isSettledCheckpoint(),
  };
}
