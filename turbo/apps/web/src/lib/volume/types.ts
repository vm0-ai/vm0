/**
 * Volume configuration from vm0.config.yaml
 */
export interface VolumeConfig {
  driver: string;
  driver_opts: {
    uri: string;
    region: string;
  };
}

/**
 * Resolved volume with all template variables replaced
 */
export interface ResolvedVolume {
  name: string;
  s3Uri: string;
  mountPath: string;
  region: string;
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
