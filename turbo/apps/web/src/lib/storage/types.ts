import type { VolumeConfig } from "../../types/agent-compose";

/**
 * Supported storage drivers:
 * - "vas": Versioned Artifact Storage (stored in S3 with versioning)
 */
export type StorageDriver = "vas";

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
 * Matches the new agent.yaml structure (dictionary format)
 */
export interface AgentVolumeConfig {
  agents?: Record<
    string,
    {
      framework?: string; // Framework name (e.g., "claude-code", "codex") for mount path resolution
      volumes?: string[];
      working_dir?: string; // Optional when framework supports auto-config
      instructions?: string; // Path to instructions file (stored as agent-instructions@{name} volume)
      skills?: string[]; // GitHub tree URLs (stored as agent-skills@{path} volumes)
    }
  >;
  volumes?: Record<string, VolumeConfig>;
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
  /** Presigned URL for manifest.json (for incremental upload) */
  manifestUrl?: string;
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
  /** Size of archive.tar.gz in bytes */
  archiveSize: number;
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
  /** Size of archive.tar.gz in bytes */
  archiveSize: number;
  /** Presigned URL for downloading manifest.json (for incremental upload) */
  manifestUrl?: string;
}

/**
 * Storage manifest for direct S3 download
 * Contains presigned URLs for all files to be downloaded directly to sandbox
 */
export interface StorageManifest {
  storages: ManifestStorage[];
  artifact: ManifestArtifact | null;
}
