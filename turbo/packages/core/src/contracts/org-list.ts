import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Org list item schema
 */
export const orgListItemSchema = z.object({
  slug: z.string(),
  role: z.string(),
});
export type OrgListItem = z.infer<typeof orgListItemSchema>;

/**
 * Org list response schema
 */
export const orgListResponseSchema = z.object({
  orgs: z.array(orgListItemSchema),
  active: z.string().optional(),
});
export type OrgListResponse = z.infer<typeof orgListResponseSchema>;

/**
 * Org list contract for GET /api/org/list
 */
export const orgListContract = c.router({
  /**
   * GET /api/org/list
   * List all orgs accessible to the user
   */
  list: {
    method: "GET",
    path: "/api/org/list",
    headers: authHeadersSchema,
    responses: {
      200: orgListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all accessible orgs",
  },
});

export type OrgListContract = typeof orgListContract;
