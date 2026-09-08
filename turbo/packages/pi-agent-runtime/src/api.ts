import { classifyPiApiProviderFailure } from "./api-failure";
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
import {
  PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  PiMemoryStage1ProviderError,
  projectPiMemoryStage1History,
  redactPiMemoryStage1Secrets,
  resolvePiMemoryStage1ContextWindow,
  runPiMemoryStage1Extraction,
  truncatePiMemoryStage1History,
} from "./stage1-memory";
import { runPiMemoryPhase2Consolidation as runPiMemoryPhase2ConsolidationImpl } from "./phase2-memory";
import {
  PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
  PI_MEMORY_PHASE2_MAINTENANCE_REASONING,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES,
  PI_MEMORY_PHASE2_MEMORY_MAX_BYTES,
  PI_MEMORY_PHASE2_PREPARED_MAX_BYTES,
  PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
  PiMemoryPhase2EngineError,
  type PiMemoryPhase2BaseFile,
  type PiMemoryPhase2ConsolidationArgs,
  type PiMemoryPhase2ConsolidationResult,
  type PiMemoryPhase2DiffSummary,
  type PiMemoryPhase2FailureClass,
  type PiMemoryPhase2FailureCounts,
  type PiMemoryPhase2LifecycleEvent,
  type PiMemoryPhase2NoDiffResult,
  type PiMemoryPhase2PreparedFile,
  type PiMemoryPhase2PreparedManifest,
  type PiMemoryPhase2PreparedResult,
  type PiMemoryPhase2ProviderUsage,
  type PiMemoryPhase2SelectedSnapshot,
  type PiMemoryPhase2UsageEvent,
  type RunPiMemoryPhase2Consolidation,
} from "./phase2-memory-types";
import type {
  PiMemoryStage1ProviderResult,
  PiMemoryStage1ProviderUsage,
} from "./stage1-memory";
export {
  classifyPiApiProviderFailure,
  PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  PiMemoryStage1ProviderError,
  projectPiMemoryStage1History,
  redactPiMemoryStage1Secrets,
  resolvePiMemoryStage1ContextWindow,
  runPiMemoryStage1Extraction,
  truncatePiMemoryStage1History,
  PiApiFirstTurnCompactionRequiredError,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
  PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
  PI_MEMORY_PHASE2_MAINTENANCE_REASONING,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES,
  PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES,
  PI_MEMORY_PHASE2_MEMORY_MAX_BYTES,
  PI_MEMORY_PHASE2_PREPARED_MAX_BYTES,
  PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES,
  PiMemoryPhase2EngineError,
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
  PiMemoryStage1ProviderResult,
  PiMemoryStage1ProviderUsage,
  PiMemoryPhase2BaseFile,
  PiMemoryPhase2ConsolidationArgs,
  PiMemoryPhase2ConsolidationResult,
  PiMemoryPhase2DiffSummary,
  PiMemoryPhase2FailureClass,
  PiMemoryPhase2FailureCounts,
  PiMemoryPhase2LifecycleEvent,
  PiMemoryPhase2NoDiffResult,
  PiMemoryPhase2PreparedFile,
  PiMemoryPhase2PreparedManifest,
  PiMemoryPhase2PreparedResult,
  PiMemoryPhase2ProviderUsage,
  PiMemoryPhase2SelectedSnapshot,
  PiMemoryPhase2UsageEvent,
  RunPiMemoryPhase2Consolidation,
};

/** Run one restricted Phase 2 maintenance attempt behind a stable API type. */
export const runPiMemoryPhase2Consolidation: RunPiMemoryPhase2Consolidation =
  runPiMemoryPhase2ConsolidationImpl;

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

/** Project canonical Pi JSONL into a citation-free user export derivative. */
export function projectPiSessionJsonlForExport(jsonl: string): string {
  return MemoryPiSession.fromJsonl(jsonl).toPublicJsonl();
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
