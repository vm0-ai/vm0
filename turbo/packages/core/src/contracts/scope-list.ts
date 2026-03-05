import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Scope list item schema
 */
export const scopeListItemSchema = z.object({
  slug: z.string(),
  role: z.string(),
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
