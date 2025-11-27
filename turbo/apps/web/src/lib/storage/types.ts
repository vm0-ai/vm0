import type { VolumeConfig } from "../../types/agent-config";

/**
 * Supported storage drivers:
 * - "vas": Versioned Artifact Storage (stored in S3 with versioning)
 */
export type StorageDriver = "vas";

/**
 * Storage type distinguishes between static volumes and artifacts
 */
export type StorageType = "volume" | "artifact";

// Re-export VolumeConfig from agent-config for convenience
export type { VolumeConfig };

/**
 * Resolved volume with all template variables replaced
 */
export interface ResolvedVolume {
  name: string;
  driver: StorageDriver;
  mountPath: string;
  vasStorageName: string;
  vasVersion: string; // Version hash or "latest"
}

/**
 * Resolved artifact (VAS only)
 */
export interface ResolvedArtifact {
  driver: StorageDriver;
  mountPath: string; // Same as working_dir
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
 * Matches the new agent.yaml structure
 */
export interface AgentVolumeConfig {
  agents?: Array<{
    volumes?: string[];
    working_dir: string;
  }>;
  volumes?: Record<string, VolumeConfig>;
}

/**
 * Prepared storage with local path and mount information
 */
export interface PreparedStorage {
  name: string;
  driver: StorageDriver;
  localPath?: string;
  mountPath: string;
  vasStorageName: string;
  vasVersionId: string;
}

/**
 * Prepared artifact with local path and mount information (VAS only)
 */
export interface PreparedArtifact {
  driver: StorageDriver;
  localPath?: string;
  mountPath: string;
  vasStorageName: string;
  vasVersionId: string;
}

/**
 * Result of storage preparation (resolution + download)
 */
export interface StoragePreparationResult {
  preparedStorages: PreparedStorage[];
  preparedArtifact: PreparedArtifact | null;
  tempDir: string | null;
  errors: string[];
}
