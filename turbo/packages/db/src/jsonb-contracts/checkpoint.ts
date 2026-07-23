import type { ContextArtifact, PersistedStorageMount } from "../types";
import type { JsonValue } from "./shared";

export type CheckpointAgentComposeSnapshot = JsonValue;
export type CheckpointArtifactSnapshots = ContextArtifact[];
export type CheckpointVolumeVersionsSnapshot = JsonValue;
export type CheckpointStorageMounts = PersistedStorageMount[];
