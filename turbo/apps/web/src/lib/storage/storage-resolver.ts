import type {
  AgentVolumeConfig,
  VolumeConfig,
  ArtifactConfig,
  ResolvedVolume,
  ResolvedArtifact,
  VolumeResolutionResult,
  VolumeError,
  StorageDriver,
} from "./types";

/**
 * Parse mount path declaration
 * @param declaration - Volume declaration in format "volume-name:/mount/path"
 * @returns Parsed volume name and mount path
 */
export function parseMountPath(declaration: string): {
  volumeName: string;
  mountPath: string;
} {
  const parts = declaration.split(":");
  if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
    throw new Error(
      `Invalid volume declaration: ${declaration}. Expected format: volume-name:/mount/path`,
    );
  }

  return {
    volumeName: parts[0]!.trim(),
    mountPath: parts[1]!.trim(),
  };
}

/**
 * Replace template variables in a string
 * @param str - String with template variables like {{userId}}
 * @param vars - Variable values
 * @returns String with variables replaced and list of missing vars
 */
export function replaceTemplateVars(
  str: string,
  vars: Record<string, string>,
): { uri: string; missingVars: string[] } {
  const templatePattern = /\{\{(\w+)\}\}/g;
  const missingVars: string[] = [];
  let result = str;

  const matches = str.matchAll(templatePattern);
  for (const match of matches) {
    const varName = match[1]!;
    const value = vars[varName];

    if (value === undefined) {
      missingVars.push(varName);
    } else {
      result = result.replace(match[0]!, value);
    }
  }

  return { uri: result, missingVars };
}

/**
 * Resolve a VAS volume configuration
 */
function resolveVasVolume(
  volumeName: string,
  mountPath: string,
  volumeConfig: VolumeConfig,
  dynamicVars: Record<string, string>,
): { volume: ResolvedVolume; error: VolumeError | null } {
  // Replace template variables in URI
  const { uri, missingVars } = replaceTemplateVars(
    volumeConfig.driver_opts.uri,
    dynamicVars,
  );

  if (missingVars.length > 0) {
    return {
      volume: null as unknown as ResolvedVolume,
      error: {
        volumeName,
        message: `Missing required variables: ${missingVars.join(", ")}`,
        type: "missing_variable",
      },
    };
  }

  // Parse vas:// URI
  const vasUriPattern = /^vas:\/\/(.+)$/;
  const match = uri.match(vasUriPattern);

  if (!match) {
    return {
      volume: null as unknown as ResolvedVolume,
      error: {
        volumeName,
        message: `Invalid VAS URI: ${uri}. Expected format: vas://volume-name`,
        type: "invalid_uri",
      },
    };
  }

  const vasStorageName = match[1];

  return {
    volume: {
      name: volumeName,
      driver: "vas" as StorageDriver,
      mountPath,
      vasStorageName,
    },
    error: null,
  };
}

/**
 * Resolve artifact configuration
 */
function resolveArtifact(
  artifactConfig: ArtifactConfig,
  artifactKey?: string,
): { artifact: ResolvedArtifact | null; errors: VolumeError[] } {
  const errors: VolumeError[] = [];

  // VAS driver: artifact key is required at runtime
  if (!artifactKey) {
    errors.push({
      volumeName: "artifact",
      message:
        "VAS artifact configured but no artifact key provided. Use --artifact flag to specify artifact.",
      type: "missing_artifact_key",
    });
    return { artifact: null, errors };
  }

  return {
    artifact: {
      driver: "vas",
      mountPath: artifactConfig.working_dir,
      vasStorageName: artifactKey,
    },
    errors: [],
  };
}

/**
 * Resolve volumes from agent configuration
 * @param config - Agent configuration with volume definitions
 * @param dynamicVars - Dynamic variables for template replacement
 * @param artifactKey - Artifact key for VAS driver (optional)
 * @param skipArtifact - Skip artifact resolution (used when resuming from checkpoint)
 * @returns Resolution result with resolved volumes, artifact, and errors
 */
export function resolveVolumes(
  config: AgentVolumeConfig,
  dynamicVars: Record<string, string> = {},
  artifactKey?: string,
  skipArtifact?: boolean,
): VolumeResolutionResult {
  const volumes: ResolvedVolume[] = [];
  const errors: VolumeError[] = [];
  let artifact: ResolvedArtifact | null = null;

  // Get working_dir from artifact config for validation
  const workingDir = config.agent?.artifact?.working_dir;

  // Process volume declarations
  if (config.agent?.volumes && config.agent.volumes.length > 0) {
    for (const declaration of config.agent.volumes) {
      try {
        const { volumeName, mountPath } = parseMountPath(declaration);

        // Validate: volumes cannot mount to working_dir
        if (workingDir && mountPath === workingDir) {
          errors.push({
            volumeName,
            message: `Volume "${volumeName}" cannot mount to working_dir (${workingDir}). Only artifact can mount to working_dir.`,
            type: "working_dir_conflict",
          });
          continue;
        }

        // Look up volume definition, or auto-resolve by name
        let volumeConfig = config.volumes?.[volumeName];

        // If no explicit volume definition, auto-resolve as VAS volume by name
        // This allows simple volume declarations like "my-volume:/mount/path"
        // to automatically resolve to vas://my-volume
        if (!volumeConfig) {
          volumeConfig = {
            driver: "vas",
            driver_opts: {
              uri: `vas://${volumeName}`,
            },
          };
        }

        // Validate driver (only vas supported for volumes)
        if (volumeConfig.driver !== "vas") {
          errors.push({
            volumeName,
            message: `Unsupported volume driver: ${volumeConfig.driver}. Only vas driver is supported for volumes.`,
            type: "invalid_uri",
          });
          continue;
        }

        // Resolve VAS volume
        const { volume, error } = resolveVasVolume(
          volumeName,
          mountPath,
          volumeConfig,
          dynamicVars,
        );

        if (error) {
          errors.push(error);
          continue;
        }

        volumes.push(volume);
      } catch (error) {
        errors.push({
          volumeName: "unknown",
          message: error instanceof Error ? error.message : "Unknown error",
          type: "invalid_uri",
        });
      }
    }
  }

  // Process artifact configuration (skip when resuming from checkpoint)
  if (config.agent?.artifact && !skipArtifact) {
    const { artifact: resolvedArtifact, errors: artifactErrors } =
      resolveArtifact(config.agent.artifact, artifactKey);

    artifact = resolvedArtifact;
    errors.push(...artifactErrors);
  }

  return { volumes, artifact, errors };
}
