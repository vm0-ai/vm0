/**
 * Supported storage drivers for static volumes:
 * - "vm0": VM0 managed storage (stored in S3 with versioning)
 *
 * Artifact-only drivers:
 * - "git": Git repository artifacts (supports checkpoint via branch/commit snapshots)
 */
export type StorageDriver = "vm0";
export type ArtifactDriver = "vm0" | "git";

/**
 * Storage type distinguishes between static volumes and artifacts
 */
export type StorageType = "volume" | "artifact";

/**
 * Volume config for static volumes in agent.yaml (vm0 driver only)
 */
export interface VolumeConfig {
  driver: StorageDriver;
  driver_opts: {
    uri: string; // vm0://storage-name format
  };
}

/**
 * Artifact config for work products (vm0 or git driver)
 */
export interface ArtifactConfig {
  working_dir: string;
  driver?: ArtifactDriver; // default: vm0
  driver_opts?: {
    uri?: string; // git only: repository URL
    branch?: string; // git only: branch name
    token?: string; // git only: authentication token
  };
}

/**
 * Resolved volume with all template variables replaced
 */
export interface ResolvedVolume {
  name: string;
  driver: StorageDriver;
  mountPath: string;
  vm0StorageName?: string;
}

/**
 * Resolved artifact with all template variables replaced
 */
export interface ResolvedArtifact {
  driver: ArtifactDriver;
  mountPath: string; // Same as working_dir
  // VM0 driver fields
  vm0StorageName?: string;
  // Git driver fields
  gitUri?: string;
  gitBranch?: string;
  gitToken?: string;
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
    | "working_dir_conflict";
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
  vm0StorageName?: string;
  vm0VersionId?: string;
}

/**
 * Prepared artifact with local path and mount information
 */
export interface PreparedArtifact {
  driver: ArtifactDriver;
  localPath?: string;
  mountPath: string;
  // VM0 driver fields
  vm0StorageName?: string;
  vm0VersionId?: string;
  // Git driver fields
  gitUri?: string;
  gitBranch?: string;
  gitToken?: string;
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
