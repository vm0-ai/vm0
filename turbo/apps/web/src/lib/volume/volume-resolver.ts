import type {
  AgentVolumeConfig,
  VolumeConfig,
  ResolvedVolume,
  VolumeResolutionResult,
  VolumeError,
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
 * Replace template variables in URI
 * @param uri - URI with template variables like {{userId}}
 * @param vars - Variable values
 * @returns URI with variables replaced
 */
export function replaceTemplateVars(
  uri: string,
  vars: Record<string, string>,
): { uri: string; missingVars: string[] } {
  const templatePattern = /\{\{(\w+)\}\}/g;
  const missingVars: string[] = [];
  let result = uri;

  const matches = uri.matchAll(templatePattern);
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
 * Resolve volumes from agent configuration
 * @param config - Agent configuration with volume definitions
 * @param dynamicVars - Dynamic variables for template replacement
 * @returns Resolution result with resolved volumes and errors
 */
export function resolveVolumes(
  config: AgentVolumeConfig,
  dynamicVars: Record<string, string> = {},
): VolumeResolutionResult {
  const volumes: ResolvedVolume[] = [];
  const errors: VolumeError[] = [];

  // Check for deprecated 'dynamic-volumes' format
  if ("dynamic-volumes" in config) {
    throw new Error(
      "Configuration error: 'dynamic-volumes' is deprecated. Please use 'dynamic_volumes' instead (snake_case). " +
        "Migration: Simply rename 'dynamic-volumes:' to 'dynamic_volumes:' in your config file.",
    );
  }

  // If no volume declarations, return empty result
  if (!config.agent?.volumes || config.agent.volumes.length === 0) {
    return { volumes, errors };
  }

  // Process each volume declaration
  for (const declaration of config.agent.volumes) {
    try {
      const { volumeName, mountPath } = parseMountPath(declaration);

      // Look up volume definition (static or dynamic)
      const staticVolume = config.volumes?.[volumeName];
      const dynamicVolume = config.dynamic_volumes?.[volumeName];
      const volumeConfig: VolumeConfig | undefined =
        staticVolume || dynamicVolume;

      if (!volumeConfig) {
        errors.push({
          volumeName,
          message: `Volume "${volumeName}" not found in volumes or dynamic_volumes`,
          type: "missing_definition",
        });
        continue;
      }

      // Validate driver (MVP only supports s3fs)
      if (volumeConfig.driver !== "s3fs") {
        errors.push({
          volumeName,
          message: `Unsupported volume driver: ${volumeConfig.driver}. Only s3fs is supported.`,
          type: "invalid_uri",
        });
        continue;
      }

      // Replace template variables
      const { uri, missingVars } = replaceTemplateVars(
        volumeConfig.driver_opts.uri,
        dynamicVars,
      );

      if (missingVars.length > 0) {
        errors.push({
          volumeName,
          message: `Missing required variables: ${missingVars.join(", ")}`,
          type: "missing_variable",
        });
        continue;
      }

      // Add resolved volume
      volumes.push({
        name: volumeName,
        s3Uri: uri,
        mountPath,
        region: volumeConfig.driver_opts.region,
      });
    } catch (error) {
      errors.push({
        volumeName: "unknown",
        message: error instanceof Error ? error.message : "Unknown error",
        type: "invalid_uri",
      });
    }
  }

  return { volumes, errors };
}
