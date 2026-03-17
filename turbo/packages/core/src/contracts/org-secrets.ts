import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  secretListResponseSchema,
  secretResponseSchema,
  setSecretRequestSchema,
  secretNameSchema,
} from "./secrets";

const c = initContract();

/**
 * Org secrets main contract for /api/org/secrets
 *
 * GET: List org-level secrets (any member)
 * PUT: Create or update an org-level secret (admin only)
 */
export const orgSecretsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/org/secrets",
    headers: authHeadersSchema,
    responses: {
      200: secretListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org-level secrets (metadata only)",
  },
  set: {
    method: "PUT",
    path: "/api/org/secrets",
    headers: authHeadersSchema,
    body: setSecretRequestSchema,
    responses: {
      200: secretResponseSchema,
      201: secretResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update an org-level secret (admin only)",
  },
});

export type OrgSecretsMainContract = typeof orgSecretsMainContract;

/**
 * Org secrets by name contract for /api/org/secrets/:name
 *
 * DELETE: Delete an org-level secret (admin only)
 */
export const orgSecretsByNameContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/org/secrets/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: secretNameSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an org-level secret (admin only)",
  },
});

export type OrgSecretsByNameContract = typeof orgSecretsByNameContract;
