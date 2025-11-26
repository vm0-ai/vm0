/**
 * Supported volume drivers:
 * - "vm0": VM0 managed volumes (stored in S3 with versioning)
 *
 * Artifact-only drivers:
 * - "git": Git repository artifacts (supports checkpoint via branch/commit snapshots)
 */
export type VolumeDriver = "vm0";
export type ArtifactDriver = "vm0" | "git";

/**
 * Volume type distinguishes between static volumes and artifacts
 */
export type VolumeType = "volume" | "artifact";

/**
 * Volume config for static volumes (vm0 driver only)
 */
export interface VolumeConfig {
  driver: VolumeDriver;
  driver_opts: {
    uri: string; // vm0://volume-name format
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
  driver: VolumeDriver;
  mountPath: string;
  vm0VolumeName?: string;
}

/**
 * Resolved artifact with all template variables replaced
 */
export interface ResolvedArtifact {
  driver: ArtifactDriver;
  mountPath: string; // Same as working_dir
  // VM0 driver fields
  vm0VolumeName?: string;
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
 * Prepared volume with local path and mount information
 */
export interface PreparedVolume {
  name: string;
  driver: VolumeDriver;
  localPath?: string;
  mountPath: string;
  vm0VolumeName?: string;
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
  vm0VolumeName?: string;
  vm0VersionId?: string;
  // Git driver fields
  gitUri?: string;
  gitBranch?: string;
  gitToken?: string;
}

/**
 * Result of volume preparation (resolution + download)
 */
export interface VolumePreparationResult {
  preparedVolumes: PreparedVolume[];
  preparedArtifact: PreparedArtifact | null;
  tempDir: string | null;
  errors: string[];
}
