import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { experimentalFirewallSchema } from "./runners";

const c = initContract();

/**
 * Version query parameter schema for compose versions
 *
 * Handles jsonQuery edge case where hex strings like "846e3519"
 * are parsed as JavaScript scientific notation numbers (e.g., 846e3519 = Infinity).
 *
 * Accepts: "latest" tag or 8-64 hex character version hash
 */
const composeVersionQuerySchema = z.preprocess(
  (val) => (val === undefined || val === null ? undefined : String(val)),
  z
    .string()
    .min(1, "Missing version query parameter")
    .regex(
      /^[a-f0-9]{8,64}$|^latest$/i,
      "Version must be 8-64 hex characters or 'latest'",
    ),
);

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
 * Supported apps that can be pre-installed in agent environments
 */
export const SUPPORTED_APPS = ["github"] as const;
export type SupportedApp = (typeof SUPPORTED_APPS)[number];

/**
 * Supported app version tags
 */
export const SUPPORTED_APP_TAGS = ["latest", "dev"] as const;
export type SupportedAppTag = (typeof SUPPORTED_APP_TAGS)[number];

/**
 * App name format regex: lowercase letters, numbers, and hyphens
 */
const APP_NAME_REGEX = /^[a-z0-9-]+$/;

/**
 * App string format: "app" or "app:tag"
 * Examples: "github", "github:dev", "github:latest"
 *
 * Validation order:
 * 1. Check app name format (lowercase letters, numbers, hyphens)
 * 2. Check app name is in SUPPORTED_APPS
 * 3. If tag present, check tag is in SUPPORTED_APP_TAGS
 */
const appStringSchema = z.string().superRefine((val, ctx) => {
  const [appName, tag] = val.split(":");

  // Validate app name format
  if (!appName || !APP_NAME_REGEX.test(appName)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "App name must contain only lowercase letters, numbers, and hyphens",
    });
    return;
  }

  // Validate app name is supported
  if (!SUPPORTED_APPS.includes(appName as SupportedApp)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid app: "${appName}". Supported apps: ${SUPPORTED_APPS.join(", ")}`,
    });
    return;
  }

  // Validate tag if present
  if (
    tag !== undefined &&
    !SUPPORTED_APP_TAGS.includes(tag as SupportedAppTag)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid app tag: "${tag}". Supported tags: ${SUPPORTED_APP_TAGS.join(", ")}`,
    });
  }
});

/**
 * Agent definition schema
 */
const agentDefinitionSchema = z.object({
  description: z.string().optional(),
  /**
   * @deprecated Use `apps` field instead for pre-installed tools.
   * This field will be removed in a future version.
   */
  image: z.string().optional(),
  framework: z.string().min(1, "Framework is required"),
  /**
   * Array of pre-installed apps/tools for the agent environment.
   * Format: "app" or "app:tag" (e.g., "github", "github:dev", "github:latest")
   * Default tag is "latest" if not specified.
   * Currently supported apps: "github" (includes GitHub CLI)
   */
  apps: z.array(appStringSchema).optional(),
  volumes: z.array(z.string()).optional(),
  working_dir: z.string().optional(), // Optional when provider supports auto-config
  environment: z.record(z.string(), z.string()).optional(),
  /**
   * Path to instructions file (e.g., AGENTS.md).
   * Auto-uploaded as volume and mounted at /home/user/.claude/CLAUDE.md
   */
  instructions: z
    .string()
    .min(1, "Instructions path cannot be empty")
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
          "Runner group must be in scope/name format (e.g., acme/production)",
        ),
    })
    .optional(),
  /**
   * Experimental firewall configuration for network egress control.
   * Requires experimental_runner to be configured.
   * When enabled, filters outbound traffic by domain/IP rules.
   */
  experimental_firewall: experimentalFirewallSchema.optional(),
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
   * GET /api/agent/composes?name={name}&scope={scope}
   * Get agent compose by name with HEAD version content
   * If scope is not provided, uses the authenticated user's default scope
   */
  getByName: {
    method: "GET",
    path: "/api/agent/composes",
    headers: authHeadersSchema,
    query: z.object({
      name: z.string().min(1, "Missing name query parameter"),
      scope: z.string().optional(),
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
  name: z.string(),
  headVersionId: z.string().nullable(),
  updatedAt: z.string(),
});

/**
 * Composes list route contract (/api/agent/composes/list)
 */
export const composesListContract = c.router({
  /**
   * GET /api/agent/composes/list?scope={scope}
   * List all agent composes for a scope
   * If scope is not provided, uses the authenticated user's default scope
   */
  list: {
    method: "GET",
    path: "/api/agent/composes/list",
    headers: authHeadersSchema,
    query: z.object({
      scope: z.string().optional(),
    }),
    responses: {
      200: z.object({
        composes: z.array(composeListItemSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "List all agent composes for a scope",
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
  composeResponseSchema,
  composeListItemSchema,
};

// Export inferred types for consumers
export type ComposeResponse = z.infer<typeof composeResponseSchema>;
export type ComposeListItem = z.infer<typeof composeListItemSchema>;
