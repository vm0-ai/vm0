import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { orgResponseSchema } from "./orgs";

const c = initContract();

/**
 * Zero contract for GET /api/zero/org
 * Proxies to GET /api/org
 */
export const zeroOrgContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/org",
    headers: authHeadersSchema,
    responses: {
      200: orgResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get current org (zero proxy)",
  },
});

export type ZeroOrgContract = typeof zeroOrgContract;
