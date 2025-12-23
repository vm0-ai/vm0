import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Agent name validation schema
 * - Must be 3-64 characters
 * - Letters, numbers, and hyphens only
 * - Must start and end with letter or number
 */
const agentNameSchema = z
  .string()
  .min(3, "Agent name must be at least 3 characters")
  .max(64, "Agent name must be 64 characters or less")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/,
    "Agent name must start and end with letter or number, and contain only letters, numbers, and hyphens",
  );

/**
 * Volume configuration schema
 */
const volumeConfigSchema = z.object({
  name: z.string().min(1, "Volume name is required"),
  version: z.string().min(1, "Volume version is required"),
});

/**
 * Agent definition schema
 */
const agentDefinitionSchema = z.object({
  description: z.string().optional(),
  image: z.string().min(1, "Image is required"),
  provider: z.string().min(1, "Provider is required"),
  volumes: z.array(z.string()).optional(),
  working_dir: z.string().optional(), // Optional when provider supports auto-config
  environment: z.record(z.string(), z.string()).optional(),
  /**
   * Enable network security mode for secrets.
   * When true, secrets are encrypted into proxy tokens and all traffic
   * is routed through mitmproxy -> VM0 Proxy for decryption.
   * Default: false (plaintext secrets in env vars)
   */
  beta_network_security: z.boolean().optional().default(false),
  /**
   * Path to system prompt file (e.g., AGENTS.md).
   * Auto-uploaded as volume and mounted at /home/user/.claude/CLAUDE.md
   */
  beta_system_prompt: z.string().optional(),
  /**
   * Array of GitHub tree URLs for system skills.
   * Each skill is auto-downloaded and mounted at /home/user/.claude/skills/{skillName}/
   */
  beta_system_skills: z.array(z.string()).optional(),
});

/**
 * Agent compose YAML content schema
 */
const agentComposeContentSchema = z.object({
  version: z.string().min(1, "Version is required"),
  agents: z.record(z.string(), agentDefinitionSchema),
  volumes: z.record(z.string(), volumeConfigSchema).optional(),
});

/**
 * Compose response schema (used in GET responses)
 */
const composeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  headVersionId: z.string().nullable(),
  content: agentComposeContentSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create/update compose response schema (used in POST responses)
 */
const createComposeResponseSchema = z.object({
  composeId: z.string(),
  name: z.string(),
  versionId: z.string(),
  action: z.enum(["created", "existing"]),
  updatedAt: z.string(),
});

/**
 * Composes main route contract (/api/agent/composes)
 * Handles GET by name and POST create/update
 */
export const composesMainContract = c.router({
  /**
   * GET /api/agent/composes?name={name}
   * Get agent compose by name with HEAD version content
   */
  getByName: {
    method: "GET",
    path: "/api/agent/composes",
    query: z.object({
      name: z.string().min(1, "Missing name query parameter"),
    }),
    responses: {
      200: composeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Get agent compose by name",
  },

  /**
   * POST /api/agent/composes
   * Create or update an agent compose version
   *
   * Returns 201 when a new compose is created, 200 when updating an existing compose.
   * The action field indicates whether a new version was created or an existing one reused.
   */
  create: {
    method: "POST",
    path: "/api/agent/composes",
    body: z.object({
      content: agentComposeContentSchema,
    }),
    responses: {
      200: createComposeResponseSchema,
      201: createComposeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Create or update agent compose version",
  },
});

/**
 * Composes by ID route contract (/api/agent/composes/[id])
 */
export const composesByIdContract = c.router({
  /**
   * GET /api/agent/composes/:id
   * Get agent compose by ID with HEAD version content
   */
  getById: {
    method: "GET",
    path: "/api/agent/composes/:id",
    pathParams: z.object({
      id: z.string().min(1, "Compose ID is required"),
    }),
    responses: {
      200: composeResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent compose by ID",
  },
});

/**
 * Composes versions route contract (/api/agent/composes/versions)
 */
export const composesVersionsContract = c.router({
  /**
   * GET /api/agent/composes/versions?composeId={id}&version={hash|tag}
   * Resolve a version specifier to a full version ID
   */
  resolveVersion: {
    method: "GET",
    path: "/api/agent/composes/versions",
    query: z.object({
      composeId: z.string().min(1, "Missing composeId query parameter"),
      version: z.string().min(1, "Missing version query parameter"),
    }),
    responses: {
      200: z.object({
        versionId: z.string(),
        tag: z.string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Resolve version specifier to full version ID",
  },
});

export type ComposesMainContract = typeof composesMainContract;
export type ComposesByIdContract = typeof composesByIdContract;
export type ComposesVersionsContract = typeof composesVersionsContract;

// Export schemas for reuse
export {
  agentNameSchema,
  volumeConfigSchema,
  agentDefinitionSchema,
  agentComposeContentSchema,
  composeResponseSchema,
  createComposeResponseSchema,
};
