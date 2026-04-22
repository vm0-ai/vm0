/**
 * Checkpoint module
 * Provides checkpoint creation and management for agent runs
 */

export { createCheckpoint } from "./checkpoint-service";
export type { ArtifactSnapshot } from "./types";
// MemorySnapshot export removed in #10602 — no longer consumed externally now
// that the webhook path no longer reads memorySnapshot. The type still exists
// in ./types for internal checkpoint-service/resolve-checkpoint use, and will
// be dropped entirely in #10603 when the memorySnapshot column is removed.
