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
 * Capabilities for the zero-layer capability system (ZERO_TOKEN).
 * These protect /api/zero/* routes only.
 */
export const ZERO_CAPABILITIES = [
  "agent:read",
  "agent:write",
  "agent:delete",
  "agent-run:read",
  "agent-run:write",
  "local-agent:read",
  "local-agent:write",
  "local-browser:read",
  "local-browser:write",
  "schedule:read",
  "schedule:write",
  "schedule:delete",
  "slack:write",
  "phone:read",
  "phone:write",
  "telegram:read",
  "telegram:write",
  "chat-message:write",
  "chat-message:read",
  "connector:read",
  "computer-use:write",
  "file:read",
  "file:write",
  "host:read",
  "host:write",
] as const;

/** Inferred union type of all zero capability strings. */
export type ZeroCapability = (typeof ZERO_CAPABILITIES)[number];

/** Metadata for a single zero capability. */
export interface ZeroCapabilityMeta {
  group: string;
  label: string;
}

/**
 * Exhaustive mapping from every zero capability to its UI group and label.
 * Adding a new capability to ZERO_CAPABILITIES without updating this record
 * will produce a TypeScript compile error.
 */
export const ZERO_CAPABILITY_META: Record<ZeroCapability, ZeroCapabilityMeta> =
  {
    "agent:read": { group: "Agent", label: "Read agents" },
    "agent:write": { group: "Agent", label: "Create & update agents" },
    "agent:delete": { group: "Agent", label: "Delete agents" },
    "agent-run:read": { group: "Agent Runs", label: "View runs & telemetry" },
    "agent-run:write": { group: "Agent Runs", label: "Create & cancel runs" },
    "local-agent:read": {
      group: "Local Agent",
      label: "View local-agent hosts and jobs",
    },
    "local-agent:write": {
      group: "Local Agent",
      label: "Create local-agent jobs",
    },
    "local-browser:read": {
      group: "Local Browser",
      label: "Read authorized browser context",
    },
    "local-browser:write": {
      group: "Local Browser",
      label: "Control approved browser actions",
    },
    "schedule:read": { group: "Schedules", label: "View schedules" },
    "schedule:write": {
      group: "Schedules",
      label: "Create & manage schedules",
    },
    "schedule:delete": { group: "Schedules", label: "Delete schedules" },
    "slack:write": { group: "Integrations", label: "Send Slack messages" },
    "phone:read": {
      group: "Integrations",
      label: "Download AgentPhone files",
    },
    "phone:write": {
      group: "Integrations",
      label: "Send AgentPhone messages and files",
    },
    "telegram:read": {
      group: "Integrations",
      label: "Download Telegram files",
    },
    "telegram:write": {
      group: "Integrations",
      label: "Send Telegram messages and files",
    },
    "chat-message:write": {
      group: "Integrations",
      label: "Send chat messages",
    },
    "chat-message:read": {
      group: "Integrations",
      label: "Read chat messages",
    },
    "connector:read": { group: "Connectors", label: "View connected services" },
    "computer-use:write": {
      group: "Computer Use",
      label: "Control desktop apps",
    },
    "file:read": { group: "Files", label: "Download uploaded files" },
    "file:write": { group: "Files", label: "Upload files" },
    "host:read": { group: "Hosting", label: "View hosted sites" },
    "host:write": { group: "Hosting", label: "Publish hosted sites" },
  };

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
 * Template literal that resolves to the compose's framework-derived
 * working_dir during mount-path expansion.
 */
export const MOUNT_PATH_TEMPLATE = "${{ working_dir }}";

/**
 * Mount path must be an absolute path (starts with "/") OR the literal
 * template "${{ working_dir }}" which resolves to the framework's working_dir.
 */
const mountPathSchema = z
  .string()
  .min(1, "mount_path cannot be empty")
  .refine((val) => {
    return val === MOUNT_PATH_TEMPLATE || val.startsWith("/");
  }, `mount_path must be an absolute path or "${MOUNT_PATH_TEMPLATE}"`);

/**
 * Artifact entry in compose.
 * - name: required storage name
 * - version: optional, defaults to "latest" at resolution time
 * - mount_path: optional, defaults to working_dir at resolution time.
 *   May be the literal template "${{ working_dir }}".
 */
const artifactConfigSchema = z.object({
  name: z.string().min(1, "Artifact name is required"),
  version: z.string().min(1).optional(),
  mount_path: mountPathSchema.optional(),
});

const artifactsArraySchema = z.array(artifactConfigSchema).refine((items) => {
  const names = items.map((i) => {
    return i.name;
  });
  return new Set(names).size === names.length;
}, "Artifact names must be unique");

/**
 * Agent definition schema
 */
const agentDefinitionSchema = z.object({
  description: z.string().optional(),
  framework: z.enum(["claude-code", "codex"]),
  volumes: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  /**
   * Path to instructions file (e.g., AGENTS.md).
   * Auto-uploaded as volume and mounted at /home/user/.claude/CLAUDE.md
   */
  instructions: z
    .string()
    .min(1, "Instructions path cannot be empty")
    .refine((val) => {
      return (
        !val.includes("..") && !val.startsWith("/") && !val.startsWith("\\")
      );
    }, "Instructions path must be a relative path without '..' segments")
    .optional(),
  /**
   * @deprecated Skills are no longer processed by the CLI path. Declare
   * mounts via `volumes:` / `--volume` instead. Field retained as optional
   * so older CLI clients posting `skills:` are not rejected; server strips
   * the field before persisting compose content.
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
          "Runner group must be in vm0/<name> format (e.g., vm0/production)",
        ),
    })
    .optional(),
  /**
   * VM profile for resource allocation (e.g., "vm0/default").
   * Determines rootfs image and VM resources (vCPU, memory).
   * Defaults to "vm0/default" when omitted.
   */
  experimental_profile: z
    .string()
    .regex(
      /^[a-z0-9-]+\/[a-z0-9-]+$/,
      "Profile must be in org/name format (e.g., vm0/default)",
    )
    .optional(),
  /**
   * External firewall rules for proxy-side token replacement.
   * Map format: { slack: { permissions: [...] | "all" } }
   * Resolved to full ExpandedFirewallConfig[] at runtime.
   */
  firewalls: z
    .record(
      z.string(),
      z.object({
        permissions: z.union([z.literal("all"), z.array(z.string()).min(1)]),
      }),
    )
    .optional(),
});

/**
 * Agent compose YAML content schema (CLI input — firewalls is map format)
 */
const agentComposeContentSchema = z.object({
  version: z.string().min(1, "Version is required"),
  agents: z.record(z.string(), agentDefinitionSchema),
  volumes: z.record(z.string(), volumeConfigSchema).optional(),
  artifacts: artifactsArraySchema.optional(),
});

/**
 * Agent compose content schema for API requests.
 * firewalls is no longer stored in compose content — all firewalls
 * are injected at runtime. The field is accepted as unknown for backward
 * compatibility with older stored compose versions (ignored at runtime).
 */
const agentComposeApiContentSchema = z.object({
  version: z.string().min(1, "Version is required"),
  agents: z.record(
    z.string(),
    agentDefinitionSchema.extend({
      // Legacy: older compose versions may have this field (map or expanded array).
      // Accepted for backward compat but ignored at runtime.
      firewalls: z.unknown().optional(),
    }),
  ),
  volumes: z.record(z.string(), volumeConfigSchema).optional(),
  artifacts: artifactsArraySchema.optional(),
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
    }),
    responses: {
      200: composeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
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
      403: apiErrorSchema,
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
      id: z.string().uuid("Compose ID must be a valid UUID"),
    }),
    responses: {
      200: composeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
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
      403: apiErrorSchema,
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
      403: apiErrorSchema,
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
  sound: z.string().nullable().optional(),
  headVersionId: z.string().nullable(),
  updatedAt: z.string(),
});

/**
 * Composes list route contract (/api/agent/composes/list)
 */
export const composesListContract = c.router({
  /**
   * GET /api/agent/composes/list
   * List all agent composes for an org
   * Uses the authenticated user's active org.
   */
  list: {
    method: "GET",
    path: "/api/agent/composes/list",
    headers: authHeadersSchema,
    query: z.object({}),
    responses: {
      200: z.object({
        composes: z.array(composeListItemSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List all agent composes for an org",
  },
});

/**
 * Compose metadata update schema
 */
const metadataUpdateSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  sound: z.string().optional(),
});

/**
 * Composes metadata route contract (/api/agent/composes/[id]/metadata)
 */
export const composesMetadataContract = c.router({
  /**
   * PATCH /api/agent/composes/:id/metadata
   * Update agent compose metadata (displayName, description, sound)
   */
  updateMetadata: {
    method: "PATCH",
    path: "/api/agent/composes/:id/metadata",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Compose ID is required"),
    }),
    body: metadataUpdateSchema,
    responses: {
      200: z.object({ ok: z.literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update agent compose metadata",
  },
});

/**
 * Compose instructions response schema
 */
const composeInstructionsResponseSchema = z.object({
  content: z.string().nullable(),
  filename: z.string().nullable(),
});

/**
 * Composes instructions route contract (/api/agent/composes/[id]/instructions)
 */
export const composesInstructionsContract = c.router({
  /**
   * GET /api/agent/composes/:id/instructions
   * Get the instructions content for an agent compose
   */
  getInstructions: {
    method: "GET",
    path: "/api/agent/composes/:id/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid("Compose ID must be a valid UUID"),
    }),
    responses: {
      200: composeInstructionsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent compose instructions content",
  },
});

export type ComposesMainContract = typeof composesMainContract;
export type ComposesByIdContract = typeof composesByIdContract;
export type ComposesVersionsContract = typeof composesVersionsContract;
export type ComposesListContract = typeof composesListContract;
export type ComposesMetadataContract = typeof composesMetadataContract;
export type ComposesInstructionsContract = typeof composesInstructionsContract;

// Export schemas for reuse
export {
  agentNameSchema,
  volumeConfigSchema,
  artifactConfigSchema,
  artifactsArraySchema,
  agentDefinitionSchema,
  agentComposeContentSchema,
  agentComposeApiContentSchema,
  composeResponseSchema,
  composeListItemSchema,
  metadataUpdateSchema,
  composeInstructionsResponseSchema,
};

// Export inferred types for consumers
export type ComposeResponse = z.infer<typeof composeResponseSchema>;
export type ComposeListItem = z.infer<typeof composeListItemSchema>;
export type ArtifactConfig = z.infer<typeof artifactConfigSchema>;
