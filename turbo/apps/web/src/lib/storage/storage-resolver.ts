import type {
  AgentVolumeConfig,
  VolumeConfig,
  ResolvedVolume,
  ResolvedArtifact,
  VolumeResolutionResult,
  VolumeError,
  StorageDriver,
} from "./types";
import {
  expandVariablesInString,
  getInstructionsStorageName,
  getSkillStorageName,
  parseGitHubTreeUrl,
  getValidatedFramework,
} from "@vm0/core";

/**
 * Get the mount path for instructions based on framework
 *
 * Each framework expects instructions at a specific location:
 * - claude-code: ~/.claude/
 * - codex: ~/.codex/
 *
 * @param framework - The framework name (e.g., "claude-code", "codex")
 * @returns The mount path for instructions
 * @throws Error if framework is defined but not supported
 */
function getInstructionsMountPath(framework?: string): string {
  const validatedFramework = getValidatedFramework(framework);
  if (validatedFramework === "codex") {
    return "/home/user/.codex";
  }
  return "/home/user/.claude";
}

/**
 * Get the base path for skills based on framework
 *
 * Each framework expects skills at a specific location:
 * - claude-code: ~/.claude/skills/
 * - codex: ~/.codex/skills/
 *
 * @param framework - The framework name (e.g., "claude-code", "codex")
 * @returns The base path for skills
 * @throws Error if framework is defined but not supported
 */
function getSkillsBasePath(framework?: string): string {
  const validatedFramework = getValidatedFramework(framework);
  if (validatedFramework === "codex") {
    return "/home/user/.codex/skills";
  }
  return "/home/user/.claude/skills";
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
    missingVars: missingVars.map((ref) => ref.name),
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
      driver: "vas",
      mountPath: workingDir,
      vasStorageName: artifactName,
      vasVersion: artifactVersion,
    },
    errors: [],
  };
}

/**
 * Resolve volumes from agent configuration
 * @param config - Agent configuration with volume definitions
 * @param vars - Template variables for placeholder replacement
 * @param artifactName - Required artifact storage name
 * @param artifactVersion - Optional artifact version (defaults to "latest")
 * @param skipArtifact - Skip artifact resolution (used when resuming from checkpoint)
 * @param volumeVersionOverrides - Optional volume version overrides (volume name -> version)
 * @returns Resolution result with resolved volumes, artifact, and errors
 */
// eslint-disable-next-line complexity -- TODO: refactor complex function
export function resolveVolumes(
  config: AgentVolumeConfig,
  vars: Record<string, string> = {},
  artifactName?: string,
  artifactVersion?: string,
  skipArtifact?: boolean,
  volumeVersionOverrides?: Record<string, string>,
): VolumeResolutionResult {
  const volumes: ResolvedVolume[] = [];
  const errors: VolumeError[] = [];
  let artifact: ResolvedArtifact | null = null;

  // Get first agent (currently only support one agent)
  const agentValues = config.agents ? Object.values(config.agents) : [];
  const agent = agentValues[0];

  // Get working_dir from agent config for validation
  const workingDir = agent?.working_dir;

  // Process volume declarations
  if (agent?.volumes && agent.volumes.length > 0) {
    for (const declaration of agent.volumes) {
      try {
        const { volumeName, mountPath } = parseMountPath(declaration);

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
  }

  // Get framework for mount path resolution
  const framework = agent?.framework as string | undefined;

  // Process instructions if specified
  if (agent?.instructions) {
    // Get the agent name (key in agents dictionary)
    const agentName = config.agents ? Object.keys(config.agents)[0] : undefined;
    if (agentName) {
      const storageName = getInstructionsStorageName(agentName);
      const instructionsMountPath = getInstructionsMountPath(framework);
      volumes.push({
        name: storageName,
        driver: "vas",
        mountPath: instructionsMountPath,
        vasStorageName: storageName,
        vasVersion: "latest", // Instructions uses latest version
      });
    }
  }

  // Process skills if specified
  if (agent?.skills && agent.skills.length > 0) {
    const skillsBasePath = getSkillsBasePath(framework);
    for (const skillUrl of agent.skills) {
      const parsed = parseGitHubTreeUrl(skillUrl);
      if (parsed) {
        const storageName = getSkillStorageName(parsed.fullPath);
        volumes.push({
          name: storageName,
          driver: "vas",
          mountPath: `${skillsBasePath}/${parsed.skillName}`,
          vasStorageName: storageName,
          vasVersion: "latest", // Skills use latest version
        });
      }
    }
  }

  // Process artifact (skip when resuming from checkpoint or when not provided)
  // Artifact is now optional - runs without artifact won't have persistent storage
  if (workingDir && !skipArtifact && artifactName) {
    const { artifact: resolvedArtifact, errors: artifactErrors } =
      resolveArtifact(workingDir, artifactName, artifactVersion);

    artifact = resolvedArtifact;
    errors.push(...artifactErrors);
  }

  return { volumes, artifact, errors };
}
