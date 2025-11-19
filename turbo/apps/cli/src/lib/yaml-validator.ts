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

  // Check agent section
  if (!cfg.agent || typeof cfg.agent !== "object") {
    return { valid: false, error: "Missing config.agent" };
  }

  const agent = cfg.agent as Record<string, unknown>;

  // Check agent.name
  if (!agent.name) {
    return { valid: false, error: "Missing agent.name" };
  }

  if (typeof agent.name !== "string") {
    return { valid: false, error: "agent.name must be a string" };
  }

  if (!validateAgentName(agent.name)) {
    return {
      valid: false,
      error:
        "Invalid agent.name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
    };
  }

  return { valid: true };
}
