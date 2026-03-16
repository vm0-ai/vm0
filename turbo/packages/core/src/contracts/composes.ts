import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Version query parameter schema for compose versions
 *
 * Accepts: "latest" tag or 8-64 hex character version hash
 */
const composeVersionQuerySchema = z
  .string()
  .min(1, "Missing version query parameter")
  .regex(
    /^[a-f0-9]{8,64}$|^latest$/i,
    "Version must be 8-64 hex characters or 'latest'",
  );

/**
 * Agent name regex: 3-64 chars, letters/numbers/hyphens, start and end with alphanumeric.
 */
export const AGENT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;

/**
 * Valid capability strings for experimental_capabilities.
 * Format: {resource}:{action}
 */
export const VALID_CAPABILITIES = [
  "volume:read",
  "volume:write",
  "artifact:read",
  "artifact:write",
  "memory:read",
  "memory:write",
  "agent:read",
  "agent:write",
  "agent-run:read",
  "agent-run:write",
  "schedule:read",
  "schedule:write",
] as const;

/**
 * Firewall permission schema for proxy-side token replacement.
 * Defined here (not in runners.ts) to avoid circular dependency:
 * composes.ts exports VALID_CAPABILITIES used by runners.ts.
 */
export const firewallPermissionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  rules: z.array(z.string()),
});

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
    AGENT_NAME_REGEX,
    "Agent name must start and end with letter or number, and contain only letters, numbers, and hyphens",
  );

/**
 * Volume configuration schema
 */
const volumeConfigSchema = z.object({
  name: z.string().min(1, "Volume name is required"),
  version: z.string().min(1, "Volume version is required"),
  /** When true, skip mounting without error if volume doesn't exist */
  optional: z.boolean().optional(),
});

/**
 * Agent definition schema
 *
 * Note: `image` and `working_dir` are deprecated fields.
 * The server resolves these values based on the framework.
 * User-provided values are ignored - server always overwrites them.
 */
const agentDefinitionSchema = z.object({
  description: z.string().optional(),
  framework: z.string().min(1, "Framework is required"),
  volumes: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  /**
   * Path to instructions file (e.g., AGENTS.md).
   * Auto-uploaded as volume and mounted at /home/user/.claude/CLAUDE.md
   */
  instructions: z
    .string()
    .min(1, "Instructions path cannot be empty")
    .refine(
      (val) =>
        !val.includes("..") && !val.startsWith("/") && !val.startsWith("\\"),
      "Instructions path must be a relative path without '..' segments",
    )
    .optional(),
  /**
   * Array of GitHub tree URLs for agent skills.
   * Each skill is auto-downloaded and mounted at /home/user/.claude/skills/{skillName}/
   */
  skills: z.array(z.string()).optional(),
  /**
   * Route this agent to a self-hosted runner instead of E2B.
   * When specified, runs will be queued for the specified runner group.
   */
  experimental_runner: z
    .object({
      group: z
        .string()
        .regex(
          /^[a-z0-9-]+\/[a-z0-9-]+$/,
          "Runner group must be in org/name format (e.g., acme/production)",
        ),
    })
    .optional(),
  /**
   * External firewall rules for proxy-side token replacement.
   * CLI input: map format { slack: { permissions: [...] | "all" } }
   * — expanded by CLI to full ExpandedFirewallConfig[] before API call.
   */
  experimental_firewall: z
    .record(
      z.string(),
      z.object({
        permissions: z.union([z.literal("all"), z.array(z.string()).min(1)]),
      }),
    )
    .optional(),
  /**
   * Capabilities that the agent is allowed to use.
   * Validated against VALID_CAPABILITIES at compose time.
   */
  experimental_capabilities: z
    .array(z.enum(VALID_CAPABILITIES))
    .refine((arr) => new Set(arr).size === arr.length, {
      message: "Duplicate capabilities are not allowed",
    })
    .optional(),
  /**
   * Agent metadata for display and personalization.
   * - displayName: Human-readable name shown in the UI (preserves original casing).
   * - sound: Communication tone (e.g., "professional", "friendly").
   */
  metadata: z
    .object({
      displayName: z.string().optional(),
      description: z.string().optional(),
      sound: z.string().optional(),
    })
    .optional(),
  /**
   * @deprecated Server-resolved field. User input is ignored.
   * @internal
   */
  image: z.string().optional(),
  /**
   * @deprecated Server-resolved field. User input is ignored.
   * @internal
   */
  working_dir: z.string().optional(),
});

/**
 * Agent compose YAML content schema (CLI input — experimental_firewall is map format)
 */
const agentComposeContentSchema = z.object({
  version: z.string().min(1, "Version is required"),
  agents: z.record(z.string(), agentDefinitionSchema),
  volumes: z.record(z.string(), volumeConfigSchema).optional(),
});

/**
 * Expanded firewall config schema (after CLI expansion)
 */
const expandedFirewallConfigSchema = z.object({
  name: z.string(),
  ref: z.string(),
  description: z.string().optional(),
  apis: z.array(
    z.object({
      base: z.string(),
      auth: z.object({
        headers: z.record(z.string(), z.string()),
      }),
      permissions: z.array(firewallPermissionSchema).optional(),
    }),
  ),
  placeholders: z.record(z.string(), z.string()).optional(),
});

/**
 * Agent compose content schema for API requests.
 * Same as agentComposeContentSchema but experimental_firewall is pre-expanded by CLI.
 */
const agentComposeApiContentSchema = z.object({
  version: z.string().min(1, "Version is required"),
  agents: z.record(
    z.string(),
    agentDefinitionSchema.extend({
      experimental_firewall: z.array(expandedFirewallConfigSchema).optional(),
    }),
  ),
  volumes: z.record(z.string(), volumeConfigSchema).optional(),
});

/**
 * Compose response schema (used in GET responses)
 */
const composeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  headVersionId: z.string().nullable(),
  content: agentComposeApiContentSchema.nullable(),
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
   * GET /api/agent/composes?name={name}&org={org}
   * Get agent compose by name with HEAD version content
   * If org is not provided, uses the authenticated user's default org
   */
  getByName: {
    method: "GET",
    path: "/api/agent/composes",
    headers: authHeadersSchema,
    query: z.object({
      name: z.string().min(1, "Missing name query parameter"),
      org: z.string().optional(),
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
    headers: authHeadersSchema,
    body: z.object({
      content: agentComposeApiContentSchema,
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
    headers: authHeadersSchema,
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

  /**
   * DELETE /api/agent/composes/:id
   * Delete agent compose and all associated resources (versions, schedules, permissions, etc.)
   * Returns 409 Conflict if agent has running or pending runs
   */
  delete: {
    method: "DELETE",
    path: "/api/agent/composes/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid("Compose ID is required"),
    }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete agent compose",
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
    headers: authHeadersSchema,
    query: z.object({
      composeId: z.string().min(1, "Missing composeId query parameter"),
      version: composeVersionQuerySchema,
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

/**
 * Compose list item schema (used in list response)
 */
const composeListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  headVersionId: z.string().nullable(),
  updatedAt: z.string(),
  isOwner: z.boolean(),
});

/**
 * Composes list route contract (/api/agent/composes/list)
 */
export const composesListContract = c.router({
  /**
   * GET /api/agent/composes/list?org={org}
   * List all agent composes for an org
   * If org is not provided, uses the authenticated user's default org
   */
  list: {
    method: "GET",
    path: "/api/agent/composes/list",
    headers: authHeadersSchema,
    query: z.object({
      org: z.string().optional(),
    }),
    responses: {
      200: z.object({
        composes: z.array(composeListItemSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "List all agent composes for an org",
  },
});

export type ComposesMainContract = typeof composesMainContract;
export type ComposesByIdContract = typeof composesByIdContract;
export type ComposesVersionsContract = typeof composesVersionsContract;
export type ComposesListContract = typeof composesListContract;

// Export schemas for reuse
export {
  agentNameSchema,
  volumeConfigSchema,
  agentDefinitionSchema,
  agentComposeContentSchema,
  agentComposeApiContentSchema,
  composeResponseSchema,
  composeListItemSchema,
};

// Export inferred types for consumers
export type ComposeResponse = z.infer<typeof composeResponseSchema>;
export type ComposeListItem = z.infer<typeof composeListItemSchema>;
