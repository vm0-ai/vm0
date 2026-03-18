import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  variableListResponseSchema,
  variableResponseSchema,
  setVariableRequestSchema,
  variableNameSchema,
} from "./variables";

const c = initContract();

/**
 * Org variables main contract for /api/org/variables
 *
 * GET: List org-level variables (any member)
 * PUT: Create or update an org-level variable (admin only)
 */
export const orgVariablesMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/org/variables",
    headers: authHeadersSchema,
    responses: {
      200: variableListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org-level variables (includes values)",
  },
  set: {
    method: "PUT",
    path: "/api/org/variables",
    headers: authHeadersSchema,
    body: setVariableRequestSchema,
    responses: {
      200: variableResponseSchema,
      201: variableResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update an org-level variable (admin only)",
  },
});

export type OrgVariablesMainContract = typeof orgVariablesMainContract;

/**
 * Org variables by name contract for /api/org/variables/:name
 *
 * DELETE: Delete an org-level variable (admin only)
 */
export const orgVariablesByNameContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/org/variables/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: variableNameSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an org-level variable (admin only)",
  },
});

export type OrgVariablesByNameContract = typeof orgVariablesByNameContract;
