import type {
  AgentVolumeConfig,
  VolumeConfig,
  ResolvedVolume,
  VolumeResolutionResult,
  VolumeError,
  StorageDriver,
} from "./types";
import { getValidatedFramework } from "@vm0/core/frameworks";
import { expandVariablesInString } from "@vm0/core/variable-expander";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import { resolveFrameworkInstructionsMountPath } from "../framework/framework-config";

/**
 * Get the mount path for instructions based on framework.
 *
 * Each framework expects instructions at a specific location:
 * - claude-code: /home/user/.claude
 * - codex: /home/user/.codex
 *
 * @param framework - The framework name (undefined defaults to claude-code)
 * @returns The mount path for instructions
 * @throws Error if framework is defined but not supported
 */
function getInstructionsMountPath(framework?: string): string {
  const validated = getValidatedFramework(framework);
  return resolveFrameworkInstructionsMountPath(validated);
}

/**
 * Parse mount path declaration
 * @param declaration - Volume declaration in format "volume-name:/mount/path"
 * @returns Parsed volume name and mount path
 */
function parseMountPath(declaration: string): {
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
 * Uses core library's unified ${{ vars.xxx }} syntax
 * @param str - String with template variables like ${{ vars.userId }}
 * @param vars - Variable values (from --vars CLI option)
 * @returns String with variables replaced and list of missing vars
 */
function replaceTemplateVars(
  str: string,
  vars: Record<string, string>,
): { result: string; missingVars: string[] } {
  const { result, missingVars } = expandVariablesInString(str, { vars });
  return {
    result,
    missingVars: missingVars.map((ref) => {
      return ref.name;
    }),
  };
}

/**
 * Resolve a VAS volume configuration
 */
function resolveVasVolume(
  volumeName: string,
  mountPath: string,
  volumeConfig: VolumeConfig,
  vars: Record<string, string>,
): { volume: ResolvedVolume | null; error: VolumeError | null } {
  // Replace template variables in storage name
  const { result: storageName, missingVars } = replaceTemplateVars(
    volumeConfig.name,
    vars,
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
    replaceTemplateVars(volumeConfig.version, vars);

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
      driver: "vas" as StorageDriver,
      mountPath,
      vasStorageName: storageName,
      vasVersion: version,
      optional: volumeConfig.optional,
      system: volumeConfig.system,
    },
    error: null,
  };
}

/**
 * Process volume declarations from agent config into resolved volumes.
 */
function processVolumeDeclarations(
  declarations: string[],
  volumeDefinitions: Record<string, VolumeConfig> | undefined,
  vars: Record<string, string>,
  volumeVersionOverrides: Record<string, string> | undefined,
): { volumes: ResolvedVolume[]; errors: VolumeError[] } {
  const volumes: ResolvedVolume[] = [];
  const errors: VolumeError[] = [];

  for (const declaration of declarations) {
    try {
      const { volumeName, mountPath } = parseMountPath(declaration);

      // Look up volume definition - required in new format
      const volumeConfig = volumeDefinitions?.[volumeName];

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

      // Check for version override
      const versionOverride = volumeVersionOverrides?.[volumeName];
      const effectiveVolumeConfig = versionOverride
        ? { ...volumeConfig, version: versionOverride }
        : volumeConfig;

      // Resolve VAS volume (with possible version override)
      const { volume, error } = resolveVasVolume(
        volumeName,
        mountPath,
        effectiveVolumeConfig,
        vars,
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

  return { volumes, errors };
}

/**
 * Resolve instruction volumes for an agent.
 */
function resolveInstructions(
  config: AgentVolumeConfig,
  agent: { instructions?: unknown; framework?: unknown },
): ResolvedVolume[] {
  const volumes: ResolvedVolume[] = [];
  const framework = agent.framework as string | undefined;

  if (agent.instructions) {
    const agentName = config.agents ? Object.keys(config.agents)[0] : undefined;
    if (agentName) {
      const storageName = getInstructionsStorageName(agentName);
      const instructionsMountPath = getInstructionsMountPath(framework);
      volumes.push({
        name: storageName,
        driver: "vas",
        mountPath: instructionsMountPath,
        vasStorageName: storageName,
        vasVersion: "latest",
      });
    }
  }

  return volumes;
}

/**
 * Resolve volumes from agent configuration.
 *
 * @param config - Agent configuration with volume definitions
 * @param vars - Template variables for placeholder replacement
 * @param volumeVersionOverrides - Optional volume version overrides (volume name -> version)
 * @returns Resolution result with resolved volumes and errors
 */
export function resolveVolumes(
  config: AgentVolumeConfig,
  vars: Record<string, string> = {},
  volumeVersionOverrides?: Record<string, string>,
): VolumeResolutionResult {
  const volumes: ResolvedVolume[] = [];
  const errors: VolumeError[] = [];

  // Get first agent (currently only support one agent)
  const agentValues = config.agents ? Object.values(config.agents) : [];
  const agent = agentValues[0];

  // Process volume declarations
  if (agent?.volumes && agent.volumes.length > 0) {
    const { volumes: declaredVolumes, errors: declaredErrors } =
      processVolumeDeclarations(
        agent.volumes,
        config.volumes,
        vars,
        volumeVersionOverrides,
      );
    volumes.push(...declaredVolumes);
    errors.push(...declaredErrors);
  }

  // Process instructions
  if (agent) {
    volumes.push(...resolveInstructions(config, agent));
  }

  return { volumes, errors };
}
