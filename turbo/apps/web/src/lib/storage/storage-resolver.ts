import type {
  AgentVolumeConfig,
  VolumeConfig,
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
): { result: string; missingVars: string[] } {
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

  return { result, missingVars };
}

/**
 * Resolve a VM0 volume configuration
 */
function resolveVm0Volume(
  volumeName: string,
  mountPath: string,
  volumeConfig: VolumeConfig,
  dynamicVars: Record<string, string>,
): { volume: ResolvedVolume | null; error: VolumeError | null } {
  // Replace template variables in storage name
  const { result: storageName, missingVars } = replaceTemplateVars(
    volumeConfig.name,
    dynamicVars,
  );

  if (missingVars.length > 0) {
    return {
      volume: null,
      error: {
        volumeName,
        message: `Missing required variables: ${missingVars.join(", ")}`,
        type: "missing_variable",
      },
    };
  }

  // Replace template variables in version
  const { result: version, missingVars: versionMissingVars } =
    replaceTemplateVars(volumeConfig.version, dynamicVars);

  if (versionMissingVars.length > 0) {
    return {
      volume: null,
      error: {
        volumeName,
        message: `Missing required variables in version: ${versionMissingVars.join(", ")}`,
        type: "missing_variable",
      },
    };
  }

  return {
    volume: {
      name: volumeName,
      driver: "vm0" as StorageDriver,
      mountPath,
      vm0StorageName: storageName,
      vm0Version: version,
    },
    error: null,
  };
}

/**
 * Resolve artifact configuration
 * @param workingDir - Working directory where artifact will be mounted
 * @param artifactName - Required artifact storage name
 * @param artifactVersion - Optional version (defaults to "latest")
 */
function resolveArtifact(
  workingDir: string,
  artifactName: string,
  artifactVersion: string = "latest",
): { artifact: ResolvedArtifact; errors: VolumeError[] } {
  return {
    artifact: {
      driver: "vm0",
      mountPath: workingDir,
      vm0StorageName: artifactName,
      vm0Version: artifactVersion,
    },
    errors: [],
  };
}

/**
 * Resolve volumes from agent configuration
 * @param config - Agent configuration with volume definitions
 * @param dynamicVars - Dynamic variables for template replacement
 * @param artifactName - Required artifact storage name
 * @param artifactVersion - Optional artifact version (defaults to "latest")
 * @param skipArtifact - Skip artifact resolution (used when resuming from checkpoint)
 * @returns Resolution result with resolved volumes, artifact, and errors
 */
export function resolveVolumes(
  config: AgentVolumeConfig,
  dynamicVars: Record<string, string> = {},
  artifactName?: string,
  artifactVersion?: string,
  skipArtifact?: boolean,
): VolumeResolutionResult {
  const volumes: ResolvedVolume[] = [];
  const errors: VolumeError[] = [];
  let artifact: ResolvedArtifact | null = null;

  // Get first agent (currently only support one agent)
  const agent = config.agents?.[0];

  // Get working_dir from agent config for validation
  const workingDir = agent?.working_dir;

  // Process volume declarations
  if (agent?.volumes && agent.volumes.length > 0) {
    for (const declaration of agent.volumes) {
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

        // Look up volume definition - required in new format
        const volumeConfig = config.volumes?.[volumeName];

        if (!volumeConfig) {
          errors.push({
            volumeName,
            message: `Volume "${volumeName}" is not defined in the volumes section. Each volume must have explicit name and version.`,
            type: "missing_definition",
          });
          continue;
        }

        // Validate required fields
        if (!volumeConfig.name || !volumeConfig.version) {
          errors.push({
            volumeName,
            message: `Volume "${volumeName}" must have both 'name' and 'version' fields.`,
            type: "invalid_config",
          });
          continue;
        }

        // Resolve VM0 volume
        const { volume, error } = resolveVm0Volume(
          volumeName,
          mountPath,
          volumeConfig,
          dynamicVars,
        );

        if (error) {
          errors.push(error);
          continue;
        }

        if (volume) {
          volumes.push(volume);
        }
      } catch (error) {
        errors.push({
          volumeName: "unknown",
          message: error instanceof Error ? error.message : "Unknown error",
          type: "invalid_config",
        });
      }
    }
  }

  // Process artifact (skip when resuming from checkpoint)
  if (workingDir && !skipArtifact) {
    if (!artifactName) {
      errors.push({
        volumeName: "artifact",
        message:
          "Artifact name is required. Use --artifact-name flag to specify artifact.",
        type: "missing_artifact_name",
      });
    } else {
      const { artifact: resolvedArtifact, errors: artifactErrors } =
        resolveArtifact(workingDir, artifactName, artifactVersion);

      artifact = resolvedArtifact;
      errors.push(...artifactErrors);
    }
  }

  return { volumes, artifact, errors };
}
