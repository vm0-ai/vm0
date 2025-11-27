/**
 * Supported storage drivers:
 * - "vas": Versioned Artifact Storage (stored in S3 with versioning)
 */
export type StorageDriver = "vas";
export type ArtifactDriver = "vas";

/**
 * Storage type distinguishes between static volumes and artifacts
 */
export type StorageType = "volume" | "artifact";

/**
 * Volume config for static volumes in agent.yaml (vas driver only)
 */
export interface VolumeConfig {
  driver: StorageDriver;
  driver_opts: {
    uri: string; // vas://storage-name format
  };
}

/**
 * Artifact config for work products (vas driver)
 */
export interface ArtifactConfig {
  working_dir: string;
  driver?: ArtifactDriver; // default: vas
}

/**
 * Resolved volume with all template variables replaced
 */
export interface ResolvedVolume {
  name: string;
  driver: StorageDriver;
  mountPath: string;
  vasStorageName?: string;
}

/**
 * Resolved artifact with all template variables replaced
 */
export interface ResolvedArtifact {
  driver: ArtifactDriver;
  mountPath: string; // Same as working_dir
  vasStorageName?: string;
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
    | "invalid_uri"
    | "working_dir_conflict"
    | "missing_artifact_key";
}

/**
 * Agent configuration sections related to volumes
 */
export interface AgentVolumeConfig {
  agent?: {
    volumes?: string[];
    artifact?: ArtifactConfig;
  };
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
  vasStorageName?: string;
  vasVersionId?: string;
}

/**
 * Prepared artifact with local path and mount information
 */
export interface PreparedArtifact {
  driver: ArtifactDriver;
  localPath?: string;
  mountPath: string;
  vasStorageName?: string;
  vasVersionId?: string;
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
