import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { orgListResponseSchema } from "./org-list";

const c = initContract();

/**
 * Zero contract for GET /api/zero/org/list
 * Lists all accessible orgs for the authenticated user.
 */
export const zeroOrgListContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/org/list",
    headers: authHeadersSchema,
    responses: {
      200: orgListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all accessible orgs for the authenticated user",
  },
});

export type ZeroOrgListContract = typeof zeroOrgListContract;
