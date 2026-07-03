import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const customConnectorFieldKindSchema = z.enum(["secret", "variable"]);
export type CustomConnectorFieldKind = z.infer<
  typeof customConnectorFieldKindSchema
>;

export const customConnectorFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  kind: customConnectorFieldKindSchema,
  required: z.boolean(),
  description: z.string().max(512).optional(),
});
export type CustomConnectorField = z.infer<typeof customConnectorFieldSchema>;

export const customConnectorHeaderInjectionSchema = z.object({
  name: z.string().min(1).max(128),
  valueTemplate: z.string().min(1).max(2048),
});
export type CustomConnectorHeaderInjection = z.infer<
  typeof customConnectorHeaderInjectionSchema
>;

export const customConnectorQueryInjectionSchema = z.object({
  name: z.string().min(1).max(128),
  valueTemplate: z.string().min(1).max(2048),
});
export type CustomConnectorQueryInjection = z.infer<
  typeof customConnectorQueryInjectionSchema
>;

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
  prefixTemplates: z.array(z.string()),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  connected: z.boolean(),
  missingRequiredFields: z.array(z.string()),
  configuredFieldKeys: z.array(z.string()),
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

const customConnectorPrefixSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid URL" },
  );

export const createCustomConnectorBodySchema = z.object({
  displayName: z.string().min(1).max(128),
  prefixes: z.array(customConnectorPrefixSchema).min(1).optional(),
  headerName: z.string().min(1).max(128).optional(),
  headerTemplate: z.string().min(1).optional(),
  prefixTemplates: z.array(z.string().min(1)).min(1).optional(),
  fields: z.array(customConnectorFieldSchema).optional(),
  headerInjections: z.array(customConnectorHeaderInjectionSchema).optional(),
  queryInjections: z.array(customConnectorQueryInjectionSchema).optional(),
  slug: z.string().optional(),
});
export type CreateCustomConnectorBody = z.infer<
  typeof createCustomConnectorBodySchema
>;

export const updateCustomConnectorBodySchema = z.object({
  displayName: z.string().min(1).max(128),
  prefixTemplates: z.array(z.string().min(1)).min(1),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
});
export type UpdateCustomConnectorBody = z.infer<
  typeof updateCustomConnectorBodySchema
>;

export const setCustomConnectorSecretBodySchema = z.object({
  value: z.string().min(1),
});

export const customConnectorValueInputSchema = z.object({
  key: z.string().min(1).max(64),
  kind: customConnectorFieldKindSchema,
  value: z.string().min(1),
});
export type CustomConnectorValueInput = z.infer<
  typeof customConnectorValueInputSchema
>;

export const setCustomConnectorValuesBodySchema = z.object({
  values: z.array(customConnectorValueInputSchema),
});
export type SetCustomConnectorValuesBody = z.infer<
  typeof setCustomConnectorValuesBodySchema
>;

export const patchCustomConnectorBodySchema = z.object({
  displayName: z.string().min(1).max(128),
});
export type PatchCustomConnectorBody = z.infer<
  typeof patchCustomConnectorBodySchema
>;

export const customConnectorProposalSchema = z.object({
  operation: z.enum(["create", "update"]),
  connectorId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(128),
  prefixTemplates: z.array(z.string().min(1)).min(1),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  notes: z.string().max(2048).optional(),
});
export type CustomConnectorProposal = z.infer<
  typeof customConnectorProposalSchema
>;

export const saveCustomConnectorProposalBodySchema = z.object({
  proposal: customConnectorProposalSchema,
  values: z.array(customConnectorValueInputSchema),
  agentId: z.string().uuid().optional(),
});
export type SaveCustomConnectorProposalBody = z.infer<
  typeof saveCustomConnectorProposalBodySchema
>;

export const saveCustomConnectorProposalResponseSchema = z.object({
  connector: customConnectorResponseSchema,
  authorizedAgentId: z.string().uuid().optional(),
});
export type SaveCustomConnectorProposalResponse = z.infer<
  typeof saveCustomConnectorProposalResponseSchema
>;

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
 * PATCH: rename a custom connector (admin only — displayName only in v1)
 */
export const zeroCustomConnectorByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: customConnectorResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an org custom connector",
  },
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
  patch: {
    method: "PATCH",
    path: "/api/zero/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: patchCustomConnectorBodySchema,
    responses: {
      200: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Rename an org custom connector",
  },
  update: {
    method: "PUT",
    path: "/api/zero/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: updateCustomConnectorBodySchema,
    responses: {
      200: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update an org custom connector definition",
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

export const zeroCustomConnectorValuesContract = c.router({
  set: {
    method: "PUT",
    path: "/api/zero/custom-connectors/:id/values",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: setCustomConnectorValuesBodySchema,
    responses: {
      200: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set the calling user's values for a custom connector",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/custom-connectors/:id/values",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Clear the calling user's values for a custom connector",
  },
});
export type ZeroCustomConnectorValuesContract =
  typeof zeroCustomConnectorValuesContract;

export const zeroCustomConnectorProposalContract = c.router({
  save: {
    method: "POST",
    path: "/api/zero/custom-connectors/proposals/save",
    headers: authHeadersSchema,
    body: saveCustomConnectorProposalBodySchema,
    responses: {
      200: saveCustomConnectorProposalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Save a custom connector proposal",
  },
});
export type ZeroCustomConnectorProposalContract =
  typeof zeroCustomConnectorProposalContract;
