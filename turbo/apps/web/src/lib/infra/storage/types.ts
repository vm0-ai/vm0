import type { VolumeConfig } from "../agent-compose/types";

/**
 * Supported storage drivers:
 * - "vas": Versioned Artifact Storage (stored in S3 with versioning)
 */
export type StorageDriver = "vas";

// Re-export VolumeConfig from agent-config for convenience
export type { VolumeConfig };

/**
 * Default mount path for memory storage inside the sandbox.
 * Used by executors (E2B/Docker) and storage-service when no explicit mount path is provided.
 */
export const DEFAULT_MEMORY_MOUNT_PATH = "/home/user/.vm0/memory";

/**
 * Resolved volume with all template variables replaced
 */
export interface ResolvedVolume {
  name: string;
  driver: StorageDriver;
  mountPath: string;
  vasStorageName: string;
  vasVersion: string; // Version hash or "latest"
  /** When true, skip mounting without error if volume doesn't exist */
  optional?: boolean;
  /** When true, resolve SYSTEM_ORG first, agent org as fallback */
  system?: boolean;
}

/**
 * Resolved artifact (VAS only)
 */
export interface ResolvedArtifact {
  driver: StorageDriver;
  mountPath: string; // Resolved from framework config
  vasStorageName: string;
  vasVersion: string; // Version hash or "latest"
}

/**
 * Result of volume resolution
 */
export interface VolumeResolutionResult {
  volumes: ResolvedVolume[];
  artifact: ResolvedArtifact | null;
  errors: VolumeError[];
}

/**
 * Volume resolution error
 */
export interface VolumeError {
  volumeName: string;
  message: string;
  type:
    | "missing_definition"
    | "missing_variable"
    | "invalid_config"
    | "missing_artifact_name";
}

/**
 * Agent configuration sections related to volumes
 * Matches the new agent.yaml structure (dictionary format)
 */
export interface AgentVolumeConfig {
  agents?: Record<
    string,
    {
      framework?: string; // Framework name (e.g., "claude-code") for mount path resolution
      volumes?: string[];
      instructions?: string; // Path to instructions file (stored as agent-instructions@{name} volume)
    }
  >;
  volumes?: Record<string, VolumeConfig>;
}

/**
 * Volume passed directly at run time, bypassing compose.
 * Always optional (skip without error if not found).
 */
export interface AdditionalVolume {
  name: string; // Storage name
  version?: string; // Version hash or "latest" (defaults to "latest")
  mountPath: string; // Absolute path in sandbox
  system?: boolean; // When true, resolve against SYSTEM_ORG first, fallback to runtime org
}

/**
 * Additional artifact passed directly at run time, each with an explicit
 * mountPath. Extras beyond the primary artifact (whose mount path is derived
 * from compose's working_dir). Resolved against the runtime org.
 */
export interface AdditionalArtifact {
  name: string; // Artifact storage name
  version?: string; // Version hash or "latest" (defaults to "latest")
  mountPath: string; // Absolute path in sandbox
}

/**
 * Storage entry in manifest
 */
export interface ManifestStorage {
  name: string;
  mountPath: string;
  vasStorageName: string;
  vasVersionId: string;
  /** Presigned URL for downloading archive.tar.gz */
  archiveUrl: string;
}

/**
 * Artifact entry in manifest
 */
export interface ManifestArtifact {
  mountPath: string;
  vasStorageName: string;
  vasVersionId: string;
  /** Presigned URL for downloading archive.tar.gz */
  archiveUrl: string;
  /** Presigned URL for downloading manifest.json (for incremental upload) */
  manifestUrl?: string;
}

/**
 * Storage manifest for direct S3 download
 * Contains presigned URLs for all files to be downloaded directly to sandbox
 */
export interface StorageManifest {
  storages: ManifestStorage[];
  artifacts: ManifestArtifact[];
  memory: ManifestArtifact | null;
}
