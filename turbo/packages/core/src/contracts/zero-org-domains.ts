import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  orgDomainsResponseSchema,
  addDomainRequestSchema,
  domainActionRequestSchema,
  domainVerifyRequestSchema,
  orgMessageResponseSchema,
} from "./org-members";

const c = initContract();

/**
 * Zero contract for /api/zero/org/domains
 */
export const zeroOrgDomainsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/org/domains",
    headers: authHeadersSchema,
    responses: {
      200: orgDomainsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org domains (zero proxy)",
  },
  add: {
    method: "POST",
    path: "/api/zero/org/domains",
    headers: authHeadersSchema,
    body: addDomainRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Add a domain to the org (zero proxy)",
  },
  remove: {
    method: "DELETE",
    path: "/api/zero/org/domains",
    headers: authHeadersSchema,
    body: domainActionRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Remove a domain from the org (zero proxy)",
  },
  setVerified: {
    method: "PATCH",
    path: "/api/zero/org/domains",
    headers: authHeadersSchema,
    body: domainVerifyRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Verify or unverify a domain (zero proxy)",
  },
});

export type ZeroOrgDomainsContract = typeof zeroOrgDomainsContract;
