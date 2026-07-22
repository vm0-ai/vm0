export type ArtifactMissingRootPolicy = "fail" | "preserveParentVersion";

export interface ContextArtifact {
  name: string;
  version?: string;
  mountPath: string;
  missingRootPolicy?: ArtifactMissingRootPolicy;
}

/**
 * Canonical Storage mount persisted by run/session/checkpoint writers.
 *
 * `version` is omitted when a session should resolve the current HEAD on its
 * next turn. Run and checkpoint snapshots persist the exact resolved version.
 */
export interface PersistedStorageMount {
  orgId: string;
  userId: string;
  name: string;
  storageId: string;
  version?: string;
  mountPath: string;
  optional?: boolean;
  writeback?: boolean;
  instructionsTargetFilename?: string;
  missingRootPolicy?: ArtifactMissingRootPolicy;
}
