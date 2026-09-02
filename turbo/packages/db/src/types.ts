export type ArtifactMissingRootPolicy = "fail" | "preserveParentVersion";

export type PersistedPiMemoryRecallSelection =
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
  /** Frozen Pi prompt epoch; API-only metadata, never part of the mount wire. */
  piMemoryRecall?: PersistedPiMemoryRecallSelection;
}
