import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Scope type enum
 */
export const scopeTypeSchema = z.enum(["personal", "organization", "system"]);
export type ScopeTypeContract = z.infer<typeof scopeTypeSchema>;

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
  .refine(
    (slug) => !slug.startsWith("vm0"),
    "Scope slug cannot start with 'vm0' (reserved)",
  )
  .transform((s) => s.toLowerCase());

/**
 * Scope response schema
 */
export const scopeResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  type: scopeTypeSchema,
  displayName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScopeResponse = z.infer<typeof scopeResponseSchema>;

/**
 * Create scope request schema
 */
export const createScopeRequestSchema = z.object({
  slug: scopeSlugSchema,
  displayName: z.string().max(128).optional(),
});

export type CreateScopeRequest = z.infer<typeof createScopeRequestSchema>;

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
   * Get current user's scope
   */
  get: {
    method: "GET",
    path: "/api/scope",
    responses: {
      200: scopeResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user's scope",
  },

  /**
   * POST /api/scope
   * Create user's scope
   */
  create: {
    method: "POST",
    path: "/api/scope",
    body: createScopeRequestSchema,
    responses: {
      201: scopeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create user's scope",
  },

  /**
   * PUT /api/scope
   * Update user's scope slug
   */
  update: {
    method: "PUT",
    path: "/api/scope",
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
    summary: "Update user's scope slug",
  },
});

export type ScopeContract = typeof scopeContract;
