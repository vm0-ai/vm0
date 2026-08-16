import { z } from "zod";
import { firewallsSchema } from "@okouai/connectors/firewall-types";
import { CANONICAL_WORKING_DIR } from "./runners";

export const MOUNT_PATH_TEMPLATE = "${{ working_dir }}";

export function expandMountPath(mountPath: string | undefined): string {
  if (mountPath === undefined || mountPath === MOUNT_PATH_TEMPLATE) {
    return CANONICAL_WORKING_DIR;
  }
  return mountPath;
}

/**
 * Agent name regex: 3-64 chars, letters/numbers/hyphens, start and end with alphanumeric.
 */
export const AGENT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;

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
 * Mount path must be an absolute path (starts with "/") or the canonical
 * workspace template. When omitted, artifacts default to the canonical
 * workspace root at resolution time.
 */
const mountPathSchema = z
  .string()
  .min(1, "mount_path cannot be empty")
  .refine((val) => {
    return val === MOUNT_PATH_TEMPLATE || val.startsWith("/");
  }, "mount_path must be an absolute path or ${{ working_dir }}");

/**
 * Artifact entry in compose.
 * - name: required storage name
 * - version: optional, defaults to "latest" at resolution time
 * - mount_path: optional, defaults to the canonical workspace root at
 *   resolution time. `${{ working_dir }}` is also accepted as a shorthand for
 *   the same canonical workspace root.
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

const agentFirewallsMapSchema = z.record(
  z.string(),
  z.object({
    permissions: z.union([z.literal("all"), z.array(z.string()).min(1)]),
  }),
);
const legacyAgentFirewallsSchema = z.union([
  agentFirewallsMapSchema,
  firewallsSchema,
]);

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
   * Route this agent to the specified runner group instead of the default.
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
  firewalls: agentFirewallsMapSchema.optional(),
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
 * are injected at runtime. The field accepts documented legacy map or expanded
 * array shapes for backward compatibility (ignored at runtime).
 */
const agentComposeApiContentSchema = z.object({
  version: z.string().min(1, "Version is required"),
  agents: z.record(
    z.string(),
    agentDefinitionSchema.extend({
      // Legacy: older compose versions may have this field (map or expanded array).
      // Accepted for backward compat but ignored at runtime.
      firewalls: legacyAgentFirewallsSchema.optional(),
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
  createComposeResponseSchema,
};

// Export inferred types for consumers
export type ComposeResponse = z.infer<typeof composeResponseSchema>;
export type ArtifactConfig = z.infer<typeof artifactConfigSchema>;
