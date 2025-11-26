import type {
  AgentVolumeConfig,
  VolumeConfig,
  ArtifactConfig,
  ResolvedVolume,
  ResolvedArtifact,
  VolumeResolutionResult,
  VolumeError,
  StorageDriver,
  ArtifactDriver,
} from "./types";
import { normalizeGitUrl, validateGitUrl } from "../git/git-client";

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
 * Resolve a VM0 volume configuration
 */
function resolveVm0Volume(
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

  // Parse vm0:// URI
  const vm0UriPattern = /^vm0:\/\/(.+)$/;
  const match = uri.match(vm0UriPattern);

  if (!match) {
    return {
      volume: null as unknown as ResolvedVolume,
      error: {
        volumeName,
        message: `Invalid VM0 URI: ${uri}. Expected format: vm0://volume-name`,
        type: "invalid_uri",
      },
    };
  }

  const vm0StorageName = match[1];

  return {
    volume: {
      name: volumeName,
      driver: "vm0" as StorageDriver,
      mountPath,
      vm0StorageName,
    },
    error: null,
  };
}

/**
 * Resolve artifact configuration
 */
function resolveArtifact(
  artifactConfig: ArtifactConfig,
  dynamicVars: Record<string, string>,
  artifactKey?: string,
): { artifact: ResolvedArtifact | null; errors: VolumeError[] } {
  const errors: VolumeError[] = [];
  const driver: ArtifactDriver = artifactConfig.driver || "vm0";

  if (driver === "git") {
    // Git driver: resolve URI from config
    if (!artifactConfig.driver_opts?.uri) {
      errors.push({
        volumeName: "artifact",
        message: "Git artifact requires driver_opts.uri",
        type: "invalid_uri",
      });
      return { artifact: null, errors };
    }

    // Replace template variables in URI
    const { uri, missingVars } = replaceTemplateVars(
      artifactConfig.driver_opts.uri,
      dynamicVars,
    );

    if (missingVars.length > 0) {
      errors.push({
        volumeName: "artifact",
        message: `Missing required variables: ${missingVars.join(", ")}`,
        type: "missing_variable",
      });
      return { artifact: null, errors };
    }

    // Normalize and validate Git URL
    const normalizedUrl = normalizeGitUrl(uri);
    if (!validateGitUrl(normalizedUrl)) {
      errors.push({
        volumeName: "artifact",
        message: `Invalid Git URL: ${uri}. Only HTTPS URLs are supported.`,
        type: "invalid_uri",
      });
      return { artifact: null, errors };
    }

    // Replace template variables in branch (default to main)
    const branchTemplate = artifactConfig.driver_opts.branch || "main";
    const { uri: branch, missingVars: branchMissingVars } = replaceTemplateVars(
      branchTemplate,
      dynamicVars,
    );

    if (branchMissingVars.length > 0) {
      errors.push({
        volumeName: "artifact",
        message: `Missing required variables in branch: ${branchMissingVars.join(", ")}`,
        type: "missing_variable",
      });
      return { artifact: null, errors };
    }

    // Replace template variables in token if present
    let token: string | undefined;
    if (artifactConfig.driver_opts.token) {
      const { uri: resolvedToken, missingVars: tokenMissingVars } =
        replaceTemplateVars(artifactConfig.driver_opts.token, dynamicVars);

      if (tokenMissingVars.length > 0) {
        errors.push({
          volumeName: "artifact",
          message: `Missing required variables in token: ${tokenMissingVars.join(", ")}`,
          type: "missing_variable",
        });
        return { artifact: null, errors };
      }
      token = resolvedToken;
    }

    return {
      artifact: {
        driver: "git",
        mountPath: artifactConfig.working_dir,
        gitUri: normalizedUrl,
        gitBranch: branch,
        gitToken: token,
      },
      errors: [],
    };
  }

  // VM0 driver: artifact key is required at runtime
  if (!artifactKey) {
    // No artifact key provided - this is valid, just means no artifact mounted
    return { artifact: null, errors: [] };
  }

  return {
    artifact: {
      driver: "vm0",
      mountPath: artifactConfig.working_dir,
      vm0StorageName: artifactKey,
    },
    errors: [],
  };
}

/**
 * Resolve volumes from agent configuration
 * @param config - Agent configuration with volume definitions
 * @param dynamicVars - Dynamic variables for template replacement
 * @param artifactKey - Artifact key for VM0 driver (optional)
 * @returns Resolution result with resolved volumes, artifact, and errors
 */
export function resolveVolumes(
  config: AgentVolumeConfig,
  dynamicVars: Record<string, string> = {},
  artifactKey?: string,
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

        // If no explicit volume definition, auto-resolve as VM0 volume by name
        // This allows simple volume declarations like "my-volume:/mount/path"
        // to automatically resolve to vm0://my-volume
        if (!volumeConfig) {
          volumeConfig = {
            driver: "vm0",
            driver_opts: {
              uri: `vm0://${volumeName}`,
            },
          };
        }

        // Validate driver (only vm0 supported for volumes)
        if (volumeConfig.driver !== "vm0") {
          errors.push({
            volumeName,
            message: `Unsupported volume driver: ${volumeConfig.driver}. Only vm0 driver is supported for volumes.`,
            type: "invalid_uri",
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

  // Process artifact configuration
  if (config.agent?.artifact) {
    const { artifact: resolvedArtifact, errors: artifactErrors } =
      resolveArtifact(config.agent.artifact, dynamicVars, artifactKey);

    artifact = resolvedArtifact;
    errors.push(...artifactErrors);
  }

  return { volumes, artifact, errors };
}
