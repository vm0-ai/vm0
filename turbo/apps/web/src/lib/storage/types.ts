/**
 * Supported storage drivers for volumes and artifacts:
 * - "vm0": VM0 managed storage (stored in S3 with versioning)
 */
export type StorageDriver = "vm0";

/**
 * Storage type distinguishes between static volumes and artifacts
 */
export type StorageType = "volume" | "artifact";

/**
 * Volume config for static volumes in agent.yaml
 * Each volume requires explicit name and version
 */
export interface VolumeConfig {
  name: string; // Required: actual storage name
  version: string; // Required: version hash or "latest"
}

/**
 * Resolved volume with all template variables replaced
 */
export interface ResolvedVolume {
  name: string;
  driver: StorageDriver;
  mountPath: string;
  vm0StorageName: string;
  vm0Version: string; // Version hash or "latest"
}

/**
 * Resolved artifact (VM0 only)
 */
export interface ResolvedArtifact {
  driver: StorageDriver;
  mountPath: string; // Same as working_dir
  vm0StorageName: string;
  vm0Version: string; // Version hash or "latest"
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
    | "working_dir_conflict"
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
  vm0StorageName: string;
  vm0VersionId: string;
}

/**
 * Prepared artifact with local path and mount information (VM0 only)
 */
export interface PreparedArtifact {
  driver: StorageDriver;
  localPath?: string;
  mountPath: string;
  vm0StorageName: string;
  vm0VersionId: string;
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
