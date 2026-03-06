import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { scopeSlugSchema } from "./scopes";
import { scopeRoleSchema, scopeMemberSchema } from "./scope-members";

const c = initContract();

/**
 * Organization status response schema (used by POST /api/org create response)
 */
export const orgStatusResponseSchema = z.object({
  slug: z.string(),
  role: scopeRoleSchema,
  members: z.array(scopeMemberSchema),
  createdAt: z.string(),
});
export type OrgStatusResponse = z.infer<typeof orgStatusResponseSchema>;

/**
 * Create organization request schema
 */
export const createOrgRequestSchema = z.object({
  slug: scopeSlugSchema,
});
export type CreateOrgRequest = z.infer<typeof createOrgRequestSchema>;

/**
 * Organization contract for /api/org
 *
 * Only the create endpoint remains here for vm0-admin org creation.
 * Member management has been unified under /api/scope/* (scopeMembersContract).
 */
export const orgContract = c.router({
  /**
   * POST /api/org
   * Create a new organization (with vm0-admin slug bypass)
   */
  create: {
    method: "POST",
    path: "/api/org",
    headers: authHeadersSchema,
    body: createOrgRequestSchema,
    responses: {
      201: orgStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a new organization",
  },
});

export type OrgContract = typeof orgContract;
