import { z } from "zod";
import {
  agentNameSchema as coreAgentNameSchema,
  agentDefinitionSchema,
  volumeConfigSchema,
  agentComposeContentSchema,
} from "@vm0/core";
import { isProviderSupported } from "./provider-config";

/**
 * CLI-specific agent name schema that allows 3-character names.
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
 * Validates GitHub tree URL format for skills
 * Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 */
export function validateGitHubTreeUrl(url: string): boolean {
  const githubTreeRegex =
    /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/tree\/[^/]+\/.+$/;
  return githubTreeRegex.test(url);
}

/**
 * CLI-extended agent definition schema with provider auto-config and skills URL validation
 */
const cliAgentDefinitionSchema = agentDefinitionSchema.superRefine(
  (agent, ctx) => {
    const providerSupported = isProviderSupported(agent.provider);

    // Provider auto-config: image required when provider not supported
    if (!agent.image && !providerSupported) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Missing agent.image (required when provider is not auto-configured)",
        path: ["image"],
      });
    }

    // Provider auto-config: working_dir required when provider not supported
    if (!agent.working_dir && !providerSupported) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Missing agent.working_dir (required when provider is not auto-configured)",
        path: ["working_dir"],
      });
    }

    // GitHub tree URL validation for skills
    if (agent.skills) {
      for (let i = 0; i < agent.skills.length; i++) {
        const skillUrl = agent.skills[i];
        if (skillUrl && !validateGitHubTreeUrl(skillUrl)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid skill URL: ${skillUrl}. Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}`,
            path: ["skills", i],
          });
        }
      }
    }
  },
);

/**
 * CLI compose schema with single-agent rule and volume mount validation
 */
const cliComposeSchema = z
  .object({
    version: z.string().min(1, "Missing config.version"),
    agents: z.record(cliAgentNameSchema, cliAgentDefinitionSchema),
    volumes: z.record(z.string(), volumeConfigSchema).optional(),
  })
  .superRefine((config, ctx) => {
    const agentKeys = Object.keys(config.agents);

    // CLI business rule: at least one agent required
    if (agentKeys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agents must have at least one agent defined",
        path: ["agents"],
      });
      return;
    }

    // CLI business rule: only one agent allowed
    if (agentKeys.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Multiple agents not supported yet. Only one agent allowed.",
        path: ["agents"],
      });
      return;
    }

    // Volume mount validation
    const agentName = agentKeys[0]!;
    const agent = config.agents[agentName];
    const agentVolumes = agent?.volumes;

    if (agentVolumes && agentVolumes.length > 0) {
      if (!config.volumes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Agent references volumes but no volumes section defined. Each volume must have explicit name and version.",
          path: ["volumes"],
        });
        return;
      }

      for (const volDeclaration of agentVolumes) {
        const parts = volDeclaration.split(":");
        if (parts.length !== 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid volume declaration: ${volDeclaration}. Expected format: volume-key:/mount/path`,
            path: ["agents", agentName, "volumes"],
          });
          continue;
        }

        const volumeKey = parts[0]!.trim();
        if (!config.volumes[volumeKey]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Volume "${volumeKey}" is not defined in volumes section. Each volume must have explicit name and version.`,
            path: ["volumes", volumeKey],
          });
        }
      }
    }
  });

/**
 * Formats a Zod error into a user-friendly string
 */
function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Validation failed";

  const path = issue.path.join(".");
  const message = issue.message;

  // Root-level errors or custom messages without path context
  if (!path) return message;

  // Handle invalid_type errors with user-friendly messages
  if (issue.code === "invalid_type") {
    // Zod 4 uses 'input' instead of 'received' in types, but runtime has 'received'
    const received = (issue as unknown as { received?: string }).received;

    // Missing required fields (handles both "Required" and "Invalid input:" messages)
    const isMissing =
      received === "undefined" ||
      message.includes("received undefined") ||
      message === "Required";

    if (path === "version" && isMissing) {
      return "Missing config.version";
    }
    if (path === "agents" && isMissing) {
      return "Missing agents object in config";
    }
    // Volume field errors
    if (path.startsWith("volumes.") && path.endsWith(".name")) {
      const volumeKey = path.split(".")[1];
      return `Volume "${volumeKey}" must have a 'name' field (string)`;
    }
    if (path.startsWith("volumes.") && path.endsWith(".version")) {
      const volumeKey = path.split(".")[1];
      return `Volume "${volumeKey}" must have a 'version' field (string)`;
    }
    // Array type errors
    if (issue.expected === "array") {
      const fieldName = path.replace(/^agents\.[^.]+\./, "agent.");
      return `${fieldName} must be an array`;
    }
    // Array element type errors (number where string expected)
    if (issue.expected === "string" && received === "number") {
      const fieldName = path.replace(/^agents\.[^.]+\./, "agent.");
      const match = fieldName.match(/^(agent\.[^.]+)\.\d+$/);
      if (match) {
        return `Each entry in ${match[1]?.replace("agent.", "")} must be a string`;
      }
    }
  }

  // Handle invalid_key for agent name key validation (Zod 4 uses invalid_key instead of invalid_string)
  if (issue.code === "invalid_key" && path.startsWith("agents.")) {
    return "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.";
  }

  // Handle invalid key in record (agent name validation)
  if (message === "Invalid key in record" && path.startsWith("agents.")) {
    return "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.";
  }

  // Handle custom errors (our superRefine messages) - return without path prefix
  if (issue.code === "custom") {
    return message;
  }

  // Handle agent-level errors with cleaner paths
  if (path.startsWith("agents.")) {
    const cleanPath = path.replace(/^agents\.[^.]+\./, "agent.");
    // For "Invalid input" messages, provide cleaner error
    if (message.startsWith("Invalid input:")) {
      const match = message.match(/expected (\w+), received (\w+)/);
      if (match && match[1] === "string" && match[2] === "number") {
        const fieldMatch = cleanPath.match(/^(agent\.[^.]+)\.\d+$/);
        if (fieldMatch) {
          return `Each entry in ${fieldMatch[1]?.replace("agent.", "")} must be a string`;
        }
      }
    }
    return `${cleanPath}: ${message}`;
  }

  return `${path}: ${message}`;
}

/**
 * Validates agent.name format
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
  if (!result.success) return null;
  return name.toLowerCase();
}

/**
 * Validates agent compose structure using Zod schemas
 */
export function validateAgentCompose(config: unknown): {
  valid: boolean;
  error?: string;
} {
  // Pre-check: Better error for array agents (common mistake)
  if (
    config &&
    typeof config === "object" &&
    Array.isArray((config as Record<string, unknown>).agents)
  ) {
    return {
      valid: false,
      error:
        "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
    };
  }

  // Pre-check: Basic object check
  if (!config || typeof config !== "object") {
    return { valid: false, error: "Config must be an object" };
  }

  // Main validation using CLI compose schema
  const result = cliComposeSchema.safeParse(config);
  if (!result.success) {
    return { valid: false, error: formatZodError(result.error) };
  }

  return { valid: true };
}

// Re-export schemas for potential use by other CLI modules
export { coreAgentNameSchema, agentComposeContentSchema };
