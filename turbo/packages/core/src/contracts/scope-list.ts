import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { scopeResponseSchema } from "./scopes";

const c = initContract();

/**
 * Scope list item schema
 */
export const scopeListItemSchema = z.object({
  slug: z.string(),
  role: z.string(),
  // Deprecated: kept for backward compat with old CLI versions.
  // Will be removed in Phase 3 when the column is dropped.
  type: z.string().optional(),
});
export type ScopeListItem = z.infer<typeof scopeListItemSchema>;

/**
 * Scope list response schema
 */
export const scopeListResponseSchema = z.object({
  scopes: z.array(scopeListItemSchema),
  active: z.string().optional(),
});
export type ScopeListResponse = z.infer<typeof scopeListResponseSchema>;

/**
 * Scope use request schema
 */
export const scopeUseRequestSchema = z.object({
  slug: z.string(),
});
export type ScopeUseRequest = z.infer<typeof scopeUseRequestSchema>;

/**
 * Scope use response schema
 */
export const scopeUseResponseSchema = z.object({
  scope: scopeResponseSchema,
  token: z.string(),
  expiresAt: z.string(),
});
export type ScopeUseResponse = z.infer<typeof scopeUseResponseSchema>;

/**
 * Scope list contract for GET /api/scope/list
 */
export const scopeListContract = c.router({
  /**
   * GET /api/scope/list
   * List all scopes accessible to the user
   */
  list: {
    method: "GET",
    path: "/api/scope/list",
    headers: authHeadersSchema,
    responses: {
      200: scopeListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all accessible scopes",
  },
});

export type ScopeListContract = typeof scopeListContract;

/**
 * Scope use contract for POST /api/scope/use
 */
export const scopeUseContract = c.router({
  /**
   * POST /api/scope/use
   * Switch to a different scope (generates org access token if org scope)
   */
  use: {
    method: "POST",
    path: "/api/scope/use",
    headers: authHeadersSchema,
    body: scopeUseRequestSchema,
    responses: {
      200: scopeUseResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Switch to a different scope",
  },
});

export type ScopeUseContract = typeof scopeUseContract;
