/**
 * Supported volume drivers:
 * - "git": Git repository volumes (supports checkpoint via branch/commit snapshots)
 * - "vm0": VM0 managed volumes (stored in S3 with versioning)
 */
export type VolumeDriver = "git" | "vm0";

export interface VolumeConfig {
  driver: VolumeDriver;
  driver_opts: {
    uri: string;
    branch?: string;
    token?: string;
  };
}

/**
 * Resolved volume with all template variables replaced
 */
export interface ResolvedVolume {
  name: string;
  driver: VolumeDriver;
  mountPath: string;
  gitUri?: string;
  gitBranch?: string;
  gitToken?: string;
  vm0VolumeName?: string;
  /**
   * Whether this volume is from dynamic_volumes (true) or static volumes (false)
   * Only dynamic volumes create new versions after agent runs
   */
  isDynamic?: boolean;
}

/**
 * Result of volume resolution
 */
export interface VolumeResolutionResult {
  volumes: ResolvedVolume[];
  errors: VolumeError[];
}

/**
 * Volume resolution error
 */
export interface VolumeError {
  volumeName: string;
  message: string;
  type: "missing_definition" | "missing_variable" | "invalid_uri";
}

/**
 * Agent configuration sections related to volumes
 */
export interface AgentVolumeConfig {
  agent?: {
    volumes?: string[];
  };
  volumes?: Record<string, VolumeConfig>;
  dynamic_volumes?: Record<string, VolumeConfig>;
}

/**
 * Prepared volume with local path and mount information
 */
export interface PreparedVolume {
  name: string;
  driver: VolumeDriver;
  localPath?: string;
  mountPath: string;
  gitUri?: string;
  gitBranch?: string;
  gitToken?: string;
  vm0VolumeName?: string;
  vm0VersionId?: string;
  /**
   * Whether this volume is from dynamic_volumes (true) or static volumes (false)
   * Only dynamic volumes create new versions after agent runs
   */
  isDynamic?: boolean;
}

/**
 * Result of volume preparation (resolution + download)
 */
export interface VolumePreparationResult {
  preparedVolumes: PreparedVolume[];
  tempDir: string | null;
  errors: string[];
}
