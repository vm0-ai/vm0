import { z } from "zod";
import {
  agentDefinitionSchema,
  volumeConfigSchema,
} from "@vm0/core/contracts/composes";

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
 * CLI compose schema with single-agent rule and volume mount validation.
 * Framework validation is handled server-side.
 */
const cliComposeSchema = z
  .object({
    version: z.string().min(1, "Missing config.version"),
    agents: z.record(cliAgentNameSchema, agentDefinitionSchema),
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
 * Format an invalid_type Zod issue into a user-friendly message.
 * Returns null if no special formatting applies.
 */
function formatInvalidTypeIssue(
  path: string,
  issue: z.ZodIssue & { expected?: string },
): string | null {
  // Zod 4 uses 'input' instead of 'received' in types, but runtime has 'received'
  const received = (issue as unknown as { received?: string }).received;

  // Missing required fields (handles both "Required" and "Invalid input:" messages)
  const isMissing =
    received === "undefined" ||
    issue.message.includes("received undefined") ||
    issue.message === "Required";

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
  return null;
}

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
    const formatted = formatInvalidTypeIssue(path, issue);
    if (formatted) return formatted;
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
 * Known fields in agent definition schema, derived from the Zod schema shape.
 * Used for typo detection against unknown fields in YAML config.
 */
const KNOWN_AGENT_FIELDS = Object.keys(agentDefinitionSchema.shape);

/**
 * Computes Levenshtein edit distance between two strings.
 * Uses single-row DP optimization for O(min(m,n)) space.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) [a, b] = [b, a];

  const row = Array.from({ length: a.length + 1 }, (_, i) => {
    return i;
  });

  for (let j = 1; j <= b.length; j++) {
    let prev = j - 1;
    row[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const current = Math.min(
        row[i]! + 1, // deletion
        row[i - 1]! + 1, // insertion
        prev + cost, // substitution
      );
      prev = row[i]!;
      row[i] = current;
    }
  }

  return row[a.length]!;
}

/**
 * Finds the most similar known field for an unknown field name.
 * Uses two strategies:
 * 1. Levenshtein distance ≤ 2 for close typos (e.g., "environments" → "environment")
 * 2. Prefix containment for abbreviations (e.g., "env" → "environment")
 *
 * Returns the best matching field name, or null if no match found.
 */
function findSimilarField(
  unknown: string,
  knownFields: string[],
): string | null {
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const known of knownFields) {
    if (unknown === known) continue;

    // Check 1: Levenshtein distance ≤ 2
    const distance = levenshteinDistance(unknown, known);
    if (distance <= 2 && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = known;
    }

    // Check 2: Prefix containment (unknown is a prefix of known, min 3 chars)
    if (unknown.length >= 3 && known.startsWith(unknown) && !bestMatch) {
      bestMatch = known;
    }
  }

  return bestMatch;
}

/**
 * Extracts agent entries from raw config, with type guards.
 * Returns null if config structure is invalid for agent inspection.
 */
function extractAgentEntries(
  config: unknown,
): Record<string, Record<string, unknown>> | null {
  if (!config || typeof config !== "object") return null;
  const cfg = config as Record<string, unknown>;
  const agents = cfg.agents as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!agents || typeof agents !== "object" || Array.isArray(agents))
    return null;
  return agents;
}

/**
 * Checks for unknown fields in agent definitions that look like typos.
 * Returns an error message listing all detected typos, or null if none found.
 */
function checkForFieldTypos(config: unknown): string | null {
  const agents = extractAgentEntries(config);
  if (!agents) return null;

  const errors: string[] = [];

  for (const [agentName, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) continue;

    for (const field of Object.keys(agent)) {
      if (KNOWN_AGENT_FIELDS.includes(field)) continue;

      const suggestion = findSimilarField(field, KNOWN_AGENT_FIELDS);
      if (suggestion) {
        errors.push(
          `Unknown field "${field}" in agent "${agentName}". Did you mean "${suggestion}"?`,
        );
      }
    }
  }

  return errors.length > 0 ? errors.join("\n") : null;
}

/**
 * Checks for deprecated 'provider' field and returns migration error message
 */
function checkForDeprecatedProvider(config: unknown): string | null {
  const agents = extractAgentEntries(config);
  if (!agents) return null;

  for (const agent of Object.values(agents)) {
    if (agent && typeof agent === "object" && !Array.isArray(agent)) {
      if ("provider" in agent && !("framework" in agent)) {
        const providerValue = agent.provider;
        return `'provider' field is deprecated. Use 'framework' instead.\n\nChange in your vm0.yaml:\n  - provider: ${providerValue}\n  + framework: ${providerValue}`;
      }
    }
  }
  return null;
}

/**
 * Validates agent compose structure using Zod schemas
 */
export function validateAgentCompose(config: unknown): {
  valid: boolean;
  error?: string;
} {
  // Pre-check: Deprecated 'provider' field
  const deprecationError = checkForDeprecatedProvider(config);
  if (deprecationError) {
    return { valid: false, error: deprecationError };
  }

  // Pre-check: Detect likely typos in agent definition fields
  const typoError = checkForFieldTypos(config);
  if (typoError) {
    return { valid: false, error: typoError };
  }

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
