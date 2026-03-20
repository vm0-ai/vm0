import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { orgRoleSchema } from "./org-members";

const c = initContract();

/**
 * Org tier values
 */
export const orgTierSchema = z.enum(["free", "pro", "max"]);
export type OrgTier = z.infer<typeof orgTierSchema>;

/**
 * Org slug validation
 * - 3-64 characters (or 1-2 for single/double char slugs)
 * - lowercase letters, numbers, and hyphens only
 * - must start and end with alphanumeric
 */
export const orgSlugSchema = z
  .string()
  .min(3, "Org slug must be at least 3 characters")
  .max(64, "Org slug must be at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/,
    "Org slug must contain only lowercase letters, numbers, and hyphens, and must start and end with an alphanumeric character",
  )
  .transform((s) => s.toLowerCase());

/**
 * Org response schema
 */
export const orgResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  tier: z.string().optional(),
  role: orgRoleSchema.optional(),
});

export type OrgResponse = z.infer<typeof orgResponseSchema>;

/**
 * Update org request schema
 */
export const updateOrgRequestSchema = z.object({
  slug: orgSlugSchema.optional(),
  name: z.string().min(1).max(128).optional(),
  force: z.boolean().optional().default(false),
});

export type UpdateOrgRequest = z.infer<typeof updateOrgRequestSchema>;

/**
 * Org contract for /api/org
 */
export const orgContract = c.router({
  /**
   * GET /api/org
   * Get current user's default org
   */
  get: {
    method: "GET",
    path: "/api/org",
    headers: authHeadersSchema,
    responses: {
      200: orgResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user's default org",
  },

  /**
   * PUT /api/org
   * Update org slug
   */
  update: {
    method: "PUT",
    path: "/api/org",
    headers: authHeadersSchema,
    body: updateOrgRequestSchema,
    responses: {
      200: orgResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update org slug",
  },
});

export type OrgContract = typeof orgContract;

/**
 * Org default agent contract for /api/zero/default-agent
 */
export const orgDefaultAgentContract = c.router({
  /**
   * PUT /api/zero/default-agent?org={slug}
   * Set or unset the default agent for an org.
   * Only org admins can perform this action.
   * The agent must belong to the same org.
   */
  setDefaultAgent: {
    method: "PUT",
    path: "/api/zero/default-agent",
    headers: authHeadersSchema,
    query: z.object({
      org: z.string().optional(),
    }),
    body: z.object({
      agentComposeId: z.uuid().nullable(),
    }),
    responses: {
      200: z.object({
        agentComposeId: z.uuid().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Set or unset the default agent for an org",
  },
});

export type OrgDefaultAgentContract = typeof orgDefaultAgentContract;
