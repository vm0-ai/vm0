import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Custom connector response — safe to return to any org member.
 * Never includes any secret material.
 */
export const customConnectorResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  prefixes: z.array(z.string()),
  headerName: z.string(),
  headerTemplate: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasSecret: z.boolean(),
});
export type CustomConnectorResponse = z.infer<
  typeof customConnectorResponseSchema
>;

export const customConnectorListResponseSchema = z.object({
  connectors: z.array(customConnectorResponseSchema),
});

export const createCustomConnectorBodySchema = z.object({
  displayName: z.string().min(1).max(128),
  prefixes: z.array(z.string().url()).min(1),
  headerName: z.string().min(1).max(128),
  headerTemplate: z.string().min(1),
  slug: z.string().optional(),
});
export type CreateCustomConnectorBody = z.infer<
  typeof createCustomConnectorBodySchema
>;

export const setCustomConnectorSecretBodySchema = z.object({
  value: z.string().min(1),
});

/**
 * Zero custom connectors contract for /api/zero/custom-connectors
 * GET: list all org custom connectors (with per-user hasSecret flag)
 * POST: create a new custom connector (admin only)
 */
export const zeroCustomConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/custom-connectors",
    headers: authHeadersSchema,
    responses: {
      200: customConnectorListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org custom connectors",
  },
  create: {
    method: "POST",
    path: "/api/zero/custom-connectors",
    headers: authHeadersSchema,
    body: createCustomConnectorBodySchema,
    responses: {
      201: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create an org custom connector",
  },
});
export type ZeroCustomConnectorsContract = typeof zeroCustomConnectorsContract;

/**
 * Zero custom connector by id contract for /api/zero/custom-connectors/[id]
 * DELETE: delete a custom connector (admin only — cascades secrets)
 */
export const zeroCustomConnectorByIdContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an org custom connector",
  },
});
export type ZeroCustomConnectorByIdContract =
  typeof zeroCustomConnectorByIdContract;

/**
 * Zero custom connector secret contract for /api/zero/custom-connectors/[id]/secret
 * PUT: set the calling user's secret for this connector
 * DELETE: clear the calling user's secret
 */
export const zeroCustomConnectorSecretContract = c.router({
  set: {
    method: "PUT",
    path: "/api/zero/custom-connectors/:id/secret",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: setCustomConnectorSecretBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set the calling user's secret for a custom connector",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/custom-connectors/:id/secret",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Clear the calling user's secret for a custom connector",
  },
});
export type ZeroCustomConnectorSecretContract =
  typeof zeroCustomConnectorSecretContract;
