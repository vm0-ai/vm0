/**
 * Validates agent.name format
 * Rules:
 * - 3-64 characters
 * - Letters (a-z, A-Z), numbers (0-9), and hyphens (-) only
 * - Must start and end with letter or number (not hyphen)
 */
export function validateAgentName(name: string): boolean {
  const nameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{1,62}[a-zA-Z0-9])?$/;
  return nameRegex.test(name);
}

/**
 * Validates volume config structure
 * Each volume must have 'name' and 'version' fields
 */
function validateVolumeConfig(
  volumeKey: string,
  volumeConfig: unknown,
): string | null {
  if (!volumeConfig || typeof volumeConfig !== "object") {
    return `Volume "${volumeKey}" must be an object`;
  }

  const vol = volumeConfig as Record<string, unknown>;

  if (!vol.name || typeof vol.name !== "string") {
    return `Volume "${volumeKey}" must have a 'name' field (string)`;
  }

  if (!vol.version || typeof vol.version !== "string") {
    return `Volume "${volumeKey}" must have a 'version' field (string)`;
  }

  return null;
}

/**
 * Validates agent config structure
 */
export function validateAgentConfig(config: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "Config must be an object" };
  }

  const cfg = config as Record<string, unknown>;

  // Check version
  if (!cfg.version) {
    return { valid: false, error: "Missing config.version" };
  }

  // Check agents section (must be object, not array)
  if (!cfg.agents || typeof cfg.agents !== "object") {
    return { valid: false, error: "Missing agents object in config" };
  }

  if (Array.isArray(cfg.agents)) {
    return {
      valid: false,
      error:
        "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
    };
  }

  const agentKeys = Object.keys(cfg.agents);
  if (agentKeys.length === 0) {
    return {
      valid: false,
      error: "agents must have at least one agent defined",
    };
  }

  if (agentKeys.length > 1) {
    return {
      valid: false,
      error: "Multiple agents not supported yet. Only one agent allowed.",
    };
  }

  // Get agent name from key and validate format
  const agentName = agentKeys[0]!;

  if (!validateAgentName(agentName)) {
    return {
      valid: false,
      error:
        "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
    };
  }

  // Validate agent definition
  const agentsObj = cfg.agents as Record<string, unknown>;
  const agent = agentsObj[agentName] as Record<string, unknown> | undefined;

  if (!agent || typeof agent !== "object") {
    return { valid: false, error: "Agent definition must be an object" };
  }

  // Check agent.working_dir
  if (!agent.working_dir || typeof agent.working_dir !== "string") {
    return {
      valid: false,
      error: "Missing or invalid agent.working_dir (must be a string)",
    };
  }

  // Check agent.image
  if (!agent.image || typeof agent.image !== "string") {
    return {
      valid: false,
      error: "Missing or invalid agent.image (must be a string)",
    };
  }

  // Check agent.provider
  if (!agent.provider || typeof agent.provider !== "string") {
    return {
      valid: false,
      error: "Missing or invalid agent.provider (must be a string)",
    };
  }

  // Validate volumes section if agent uses volumes
  const agentVolumes = agent.volumes as string[] | undefined;
  if (agentVolumes && Array.isArray(agentVolumes) && agentVolumes.length > 0) {
    const volumesSection = cfg.volumes as Record<string, unknown> | undefined;

    if (!volumesSection || typeof volumesSection !== "object") {
      return {
        valid: false,
        error:
          "Agent references volumes but no volumes section defined. Each volume must have explicit name and version.",
      };
    }

    // Validate each referenced volume exists in volumes section
    for (const volDeclaration of agentVolumes) {
      if (typeof volDeclaration !== "string") {
        return {
          valid: false,
          error: "Volume declaration must be a string in format 'key:/path'",
        };
      }

      const parts = volDeclaration.split(":");
      if (parts.length !== 2) {
        return {
          valid: false,
          error: `Invalid volume declaration: ${volDeclaration}. Expected format: volume-key:/mount/path`,
        };
      }

      const volumeKey = parts[0]!.trim();
      const volumeConfig = volumesSection[volumeKey];

      if (!volumeConfig) {
        return {
          valid: false,
          error: `Volume "${volumeKey}" is not defined in volumes section. Each volume must have explicit name and version.`,
        };
      }

      // Validate volume config structure
      const volError = validateVolumeConfig(volumeKey, volumeConfig);
      if (volError) {
        return { valid: false, error: volError };
      }
    }
  }

  return { valid: true };
}
