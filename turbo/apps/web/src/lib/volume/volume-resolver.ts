import type {
  AgentVolumeConfig,
  VolumeConfig,
  ResolvedVolume,
  VolumeResolutionResult,
  VolumeError,
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

      // Validate driver
      if (
        volumeConfig.driver !== "s3fs" &&
        volumeConfig.driver !== "git" &&
        volumeConfig.driver !== "vm0"
      ) {
        errors.push({
          volumeName,
          message: `Unsupported volume driver: ${volumeConfig.driver}. Supported drivers: s3fs, git, vm0.`,
          type: "invalid_uri",
        });
        continue;
      }

      // Handle S3 volumes
      if (volumeConfig.driver === "s3fs") {
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

        // Validate region is provided for S3
        if (!volumeConfig.driver_opts.region) {
          errors.push({
            volumeName,
            message: "S3 volumes require 'region' in driver_opts",
            type: "invalid_uri",
          });
          continue;
        }

        // Add resolved S3 volume
        volumes.push({
          name: volumeName,
          driver: "s3fs",
          mountPath,
          s3Uri: uri,
          region: volumeConfig.driver_opts.region,
        });
      }

      // Handle Git volumes
      if (volumeConfig.driver === "git") {
        // Replace template variables in URI
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

        // Normalize and validate Git URL
        const normalizedUrl = normalizeGitUrl(uri);
        if (!validateGitUrl(normalizedUrl)) {
          errors.push({
            volumeName,
            message: `Invalid Git URL: ${uri}. Only HTTPS URLs are supported.`,
            type: "invalid_uri",
          });
          continue;
        }

        // Replace template variables in branch (default to main)
        const branchTemplate = volumeConfig.driver_opts.branch || "main";
        const { uri: branch, missingVars: branchMissingVars } =
          replaceTemplateVars(branchTemplate, dynamicVars);

        if (branchMissingVars.length > 0) {
          errors.push({
            volumeName,
            message: `Missing required variables in branch: ${branchMissingVars.join(", ")}`,
            type: "missing_variable",
          });
          continue;
        }

        // Add resolved Git volume
        volumes.push({
          name: volumeName,
          driver: "git",
          mountPath,
          gitUri: normalizedUrl,
          gitBranch: branch,
          gitToken: volumeConfig.driver_opts.token,
        });
      }

      // Handle VM0 volumes
      if (volumeConfig.driver === "vm0") {
        // Replace template variables in URI
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

        // Parse vm0:// URI
        const vm0UriPattern = /^vm0:\/\/(.+)$/;
        const match = uri.match(vm0UriPattern);

        if (!match) {
          errors.push({
            volumeName,
            message: `Invalid VM0 URI: ${uri}. Expected format: vm0://volume-name`,
            type: "invalid_uri",
          });
          continue;
        }

        const vm0VolumeName = match[1];

        // Add resolved VM0 volume
        volumes.push({
          name: volumeName,
          driver: "vm0",
          mountPath,
          vm0VolumeName,
        });
      }
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
