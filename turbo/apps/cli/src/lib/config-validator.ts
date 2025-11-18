import type { VM0Config } from "../types/config";

/**
 * Validate VM0 config
 * Basic validation: check required fields and types
 */
export function validateConfig(config: VM0Config): void {
  const errors: string[] = [];

  // Check version
  if (!config.version) {
    errors.push("Missing required field: version");
  } else if (typeof config.version !== "string") {
    errors.push('Field "version" must be a string');
  }

  // Check agent
  if (!config.agent) {
    errors.push("Missing required field: agent");
  } else {
    if (!config.agent.description) {
      errors.push("Missing required field: agent.description");
    }
    if (!config.agent.image) {
      errors.push("Missing required field: agent.image");
    }
    if (!config.agent.provider) {
      errors.push("Missing required field: agent.provider");
    }
    if (!config.agent.working_dir) {
      errors.push("Missing required field: agent.working_dir");
    }
    if (!config.agent.volumes) {
      errors.push("Missing required field: agent.volumes");
    } else if (!Array.isArray(config.agent.volumes)) {
      errors.push('Field "agent.volumes" must be an array');
    }
  }

  if (errors.length > 0) {
    throw new Error(
      "Config validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
}
