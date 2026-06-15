import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { orgResponseSchema, updateOrgRequestSchema } from "./orgs";
import { orgMessageResponseSchema } from "./org-members";

const c = initContract();

/**
 * Zero contract for /api/zero/org
 * Proxies to /api/org
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
  update: {
    method: "PUT",
    path: "/api/zero/org",
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
    summary: "Update org slug (zero proxy)",
  },
});

export type ZeroOrgContract = typeof zeroOrgContract;

/**
 * Zero contract for POST /api/zero/org/leave
 * Proxies to POST /api/org/leave
 */
export const zeroOrgLeaveContract = c.router({
  leave: {
    method: "POST",
    path: "/api/zero/org/leave",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Leave the current org (zero proxy)",
  },
});

export type ZeroOrgLeaveContract = typeof zeroOrgLeaveContract;

/**
 * Zero contract for DELETE /api/zero/org/delete
 */
export const zeroOrgDeleteContract = c.router({
  delete: {
    method: "POST",
    path: "/api/zero/org/delete",
    headers: authHeadersSchema,
    body: z.object({ slug: z.string() }),
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete the current org (zero proxy)",
  },
});

export type ZeroOrgDeleteContract = typeof zeroOrgDeleteContract;
