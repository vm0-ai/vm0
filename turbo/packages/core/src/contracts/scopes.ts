import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Scope tier values
 */
export const scopeTierSchema = z.enum(["free", "pro", "max"]);
export type ScopeTier = z.infer<typeof scopeTierSchema>;

/**
 * Scope slug validation
 * - 3-64 characters (or 1-2 for single/double char slugs)
 * - lowercase letters, numbers, and hyphens only
 * - must start and end with alphanumeric
 */
export const scopeSlugSchema = z
  .string()
  .min(3, "Scope slug must be at least 3 characters")
  .max(64, "Scope slug must be at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/,
    "Scope slug must contain only lowercase letters, numbers, and hyphens, and must start and end with an alphanumeric character",
  )
  .transform((s) => s.toLowerCase());

/**
 * Scope response schema
 */
export const scopeResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  tier: z.string().optional(),
});

export type ScopeResponse = z.infer<typeof scopeResponseSchema>;

/**
 * Update scope request schema
 */
export const updateScopeRequestSchema = z.object({
  slug: scopeSlugSchema,
  force: z.boolean().optional().default(false),
});

export type UpdateScopeRequest = z.infer<typeof updateScopeRequestSchema>;

/**
 * Scope contract for /api/scope
 */
export const scopeContract = c.router({
  /**
   * GET /api/scope
   * Get current user's default scope
   */
  get: {
    method: "GET",
    path: "/api/scope",
    headers: authHeadersSchema,
    responses: {
      200: scopeResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user's default scope",
  },

  /**
   * PUT /api/scope
   * Update scope slug
   */
  update: {
    method: "PUT",
    path: "/api/scope",
    headers: authHeadersSchema,
    body: updateScopeRequestSchema,
    responses: {
      200: scopeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update scope slug",
  },
});

export type ScopeContract = typeof scopeContract;

/**
 * Scope default agent contract for /api/scopes/default-agent
 */
export const scopeDefaultAgentContract = c.router({
  /**
   * PUT /api/scopes/default-agent?scope={slug}
   * Set or unset the default agent for a scope.
   * Only scope admins can perform this action.
   * The agent must belong to the same scope.
   */
  setDefaultAgent: {
    method: "PUT",
    path: "/api/scopes/default-agent",
    headers: authHeadersSchema,
    query: z.object({
      scope: z.string().optional(),
      org: z.string().optional(),
    }),
    body: z.object({
      agentComposeId: z.string().uuid().nullable(),
    }),
    responses: {
      200: z.object({
        agentComposeId: z.string().uuid().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Set or unset the default agent for a scope",
  },
});

export type ScopeDefaultAgentContract = typeof scopeDefaultAgentContract;
