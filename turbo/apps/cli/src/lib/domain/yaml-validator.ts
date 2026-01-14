import { z } from "zod";
import {
  agentNameSchema as coreAgentNameSchema,
  agentComposeContentSchema,
  SUPPORTED_APPS,
  SUPPORTED_APP_TAGS,
} from "@vm0/core";
import { isProviderSupported } from "./provider-config";

/**
 * CLI-specific agent name schema that allows 3-character names.
 * The @vm0/core schema requires 4+ characters, but CLI allows 3.
 * Pattern: start/end with alphanumeric, middle can have hyphens
 */
const cliAgentNameSchema = z
  .string()
  .min(3, "Agent name must be at least 3 characters")
  .max(64, "Agent name must be 64 characters or less")
  .regex(
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?$/,
    "Agent name must start and end with letter or number, and contain only letters, numbers, and hyphens",
  );

/**
 * Formats a Zod error into a user-friendly string
 */
function formatZodError(error: z.ZodError): string {
  const issues = error.issues;
  const firstIssue = issues[0];
  if (!firstIssue) {
    return "Validation failed";
  }

  const path = firstIssue.path.join(".");
  const message = firstIssue.message;

  // For root-level errors, just return the message
  if (!path) {
    return message;
  }

  return `${path}: ${message}`;
}

/**
 * Validates agent.name format
 * Rules:
 * - 3-64 characters
 * - Letters (a-z, A-Z), numbers (0-9), and hyphens (-) only
 * - Must start and end with letter or number (not hyphen)
 */
export function validateAgentName(name: string): boolean {
  return cliAgentNameSchema.safeParse(name).success;
}

/**
 * Normalizes agent name to lowercase
 * Returns null if the name format is invalid
 */
export function normalizeAgentName(name: string): string | null {
  const result = cliAgentNameSchema.safeParse(name);
  if (!result.success) {
    return null;
  }
  return name.toLowerCase();
}

/**
 * Validates GitHub tree URL format for skills
 * Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 */
export function validateGitHubTreeUrl(url: string): boolean {
  const githubTreeRegex =
    /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/tree\/[^/]+\/.+$/;
  return githubTreeRegex.test(url);
}

/**
 * Validates agent compose structure using Zod schemas from @vm0/core
 * with CLI-specific business rules layered on top.
 */
export function validateAgentCompose(config: unknown): {
  valid: boolean;
  error?: string;
} {
  // Step 1: Basic object check (before Zod for better error messages)
  if (!config || typeof config !== "object") {
    return { valid: false, error: "Config must be an object" };
  }

  const cfg = config as Record<string, unknown>;

  // Step 2: Check for array agents (common mistake, better error than Zod default)
  if (Array.isArray(cfg.agents)) {
    return {
      valid: false,
      error:
        "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
    };
  }

  // Step 3: Validate basic structure with Zod schema
  // Use a relaxed schema that accepts any string keys for agents (we validate names separately)
  const basicStructureSchema = z.object({
    version: z.string().min(1, "Missing config.version"),
    agents: z.record(z.string(), z.unknown()),
    volumes: z.record(z.string(), z.unknown()).optional(),
  });

  const structureResult = basicStructureSchema.safeParse(config);
  if (!structureResult.success) {
    const issue = structureResult.error.issues[0];
    if (issue?.path[0] === "version" && issue?.code === "invalid_type") {
      return { valid: false, error: "Missing config.version" };
    }
    if (issue?.path[0] === "agents") {
      return { valid: false, error: "Missing agents object in config" };
    }
    return { valid: false, error: formatZodError(structureResult.error) };
  }

  // Step 4: CLI-specific business rules
  const agentKeys = Object.keys(cfg.agents as Record<string, unknown>);

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

  // Step 5: Validate agent name format (CLI-specific regex allows 3-char names)
  const agentName = agentKeys[0]!;
  if (!validateAgentName(agentName)) {
    return {
      valid: false,
      error:
        "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
    };
  }

  // Step 6: Validate agent definition
  const agentsObj = cfg.agents as Record<string, unknown>;
  const agent = agentsObj[agentName] as Record<string, unknown> | undefined;

  if (!agent || typeof agent !== "object") {
    return { valid: false, error: "Agent definition must be an object" };
  }

  // Check provider (required)
  if (!agent.provider || typeof agent.provider !== "string") {
    return {
      valid: false,
      error: "Missing or invalid agent.provider (must be a string)",
    };
  }

  const providerIsSupported = isProviderSupported(agent.provider);

  // Check image (optional when provider supports auto-config)
  if (agent.image !== undefined && typeof agent.image !== "string") {
    return {
      valid: false,
      error: "agent.image must be a string if provided",
    };
  }
  if (!agent.image && !providerIsSupported) {
    return {
      valid: false,
      error:
        "Missing agent.image (required when provider is not auto-configured)",
    };
  }

  // Check working_dir (optional when provider is supported)
  if (
    agent.working_dir !== undefined &&
    typeof agent.working_dir !== "string"
  ) {
    return {
      valid: false,
      error: "agent.working_dir must be a string if provided",
    };
  }
  if (!agent.working_dir && !providerIsSupported) {
    return {
      valid: false,
      error:
        "Missing agent.working_dir (required when provider is not auto-configured)",
    };
  }

  // Validate instructions if present
  if (agent.instructions !== undefined) {
    if (typeof agent.instructions !== "string") {
      return {
        valid: false,
        error:
          "agent.instructions must be a string (path to instructions file)",
      };
    }
    if (agent.instructions.length === 0) {
      return {
        valid: false,
        error: "agent.instructions cannot be empty",
      };
    }
  }

  // Validate skills if present (CLI-specific GitHub URL validation)
  if (agent.skills !== undefined) {
    if (!Array.isArray(agent.skills)) {
      return {
        valid: false,
        error: "agent.skills must be an array of GitHub tree URLs",
      };
    }
    for (const skillUrl of agent.skills as unknown[]) {
      if (typeof skillUrl !== "string") {
        return {
          valid: false,
          error: "Each skill must be a string URL",
        };
      }
      if (!validateGitHubTreeUrl(skillUrl)) {
        return {
          valid: false,
          error: `Invalid skill URL: ${skillUrl}. Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}`,
        };
      }
    }
  }

  // Validate environment field if present
  if (agent.environment !== undefined) {
    if (
      agent.environment === null ||
      typeof agent.environment !== "object" ||
      Array.isArray(agent.environment)
    ) {
      return {
        valid: false,
        error:
          "agent.environment must be an object with string keys and values",
      };
    }

    const env = agent.environment as Record<string, unknown>;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") {
        return {
          valid: false,
          error: `agent.environment.${key} must be a string`,
        };
      }
    }
  }

  // Validate experimental_secrets if present
  if (agent.experimental_secrets !== undefined) {
    if (!Array.isArray(agent.experimental_secrets)) {
      return {
        valid: false,
        error: "agent.experimental_secrets must be an array of strings",
      };
    }
    for (const item of agent.experimental_secrets as unknown[]) {
      if (typeof item !== "string") {
        return {
          valid: false,
          error: "Each entry in experimental_secrets must be a string",
        };
      }
      if (item.length === 0) {
        return {
          valid: false,
          error: "experimental_secrets entries cannot be empty strings",
        };
      }
    }
  }

  // Validate experimental_vars if present
  if (agent.experimental_vars !== undefined) {
    if (!Array.isArray(agent.experimental_vars)) {
      return {
        valid: false,
        error: "agent.experimental_vars must be an array of strings",
      };
    }
    for (const item of agent.experimental_vars as unknown[]) {
      if (typeof item !== "string") {
        return {
          valid: false,
          error: "Each entry in experimental_vars must be a string",
        };
      }
      if (item.length === 0) {
        return {
          valid: false,
          error: "experimental_vars entries cannot be empty strings",
        };
      }
    }
  }

  // Validate apps if present (format: "app" or "app:tag")
  if (agent.apps !== undefined) {
    if (!Array.isArray(agent.apps)) {
      return {
        valid: false,
        error: "agent.apps must be an array of strings",
      };
    }
    for (const appEntry of agent.apps as unknown[]) {
      if (typeof appEntry !== "string") {
        return {
          valid: false,
          error: "Each entry in apps must be a string",
        };
      }

      const [appName, tag] = appEntry.split(":");
      if (!appName) {
        return {
          valid: false,
          error: `Invalid app format: "${appEntry}". Expected "app" or "app:tag"`,
        };
      }

      if (
        !SUPPORTED_APPS.includes(appName as (typeof SUPPORTED_APPS)[number])
      ) {
        return {
          valid: false,
          error: `Invalid app: "${appName}". Supported apps: ${SUPPORTED_APPS.join(", ")}`,
        };
      }

      if (
        tag !== undefined &&
        !SUPPORTED_APP_TAGS.includes(tag as (typeof SUPPORTED_APP_TAGS)[number])
      ) {
        return {
          valid: false,
          error: `Invalid app tag: "${tag}". Supported tags: ${SUPPORTED_APP_TAGS.join(", ")}`,
        };
      }
    }
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
      const volumeConfig = volumesSection[volumeKey] as
        | Record<string, unknown>
        | undefined;

      if (!volumeConfig) {
        return {
          valid: false,
          error: `Volume "${volumeKey}" is not defined in volumes section. Each volume must have explicit name and version.`,
        };
      }

      // Validate volume config structure
      if (!volumeConfig || typeof volumeConfig !== "object") {
        return {
          valid: false,
          error: `Volume "${volumeKey}" must be an object`,
        };
      }

      if (!volumeConfig.name || typeof volumeConfig.name !== "string") {
        return {
          valid: false,
          error: `Volume "${volumeKey}" must have a 'name' field (string)`,
        };
      }

      if (!volumeConfig.version || typeof volumeConfig.version !== "string") {
        return {
          valid: false,
          error: `Volume "${volumeKey}" must have a 'version' field (string)`,
        };
      }
    }
  }

  return { valid: true };
}

// Re-export schemas for potential use by other CLI modules
export { coreAgentNameSchema, agentComposeContentSchema };
