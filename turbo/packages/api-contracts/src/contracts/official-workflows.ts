import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  officialWorkflowAcceptedBlueprintSchema,
  officialWorkflowBlueprintBindingsSchema,
  officialWorkflowExecutableSchema,
  officialWorkflowLifecycleSchema,
  officialWorkflowPresentationSchema,
} from "./official-workflow-catalog";
import { workflowDetailResponseSchema, workflowNameSchema } from "./workflows";

const c = initContract();

export const officialWorkflowCatalogSummarySchema = z
  .object({
    name: workflowNameSchema,
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    displayName: z.string().min(1).max(256),
    description: z.string().min(1).max(1024),
    blueprints: z.array(officialWorkflowAcceptedBlueprintSchema),
    presentation: officialWorkflowPresentationSchema,
  })
  .strict();
export type OfficialWorkflowCatalogSummary = z.infer<
  typeof officialWorkflowCatalogSummarySchema
>;

export const officialWorkflowCatalogDetailSchema =
  officialWorkflowCatalogSummarySchema.extend({
    lifecycle: officialWorkflowLifecycleSchema,
    workflow: officialWorkflowExecutableSchema,
  });
export type OfficialWorkflowCatalogDetail = z.infer<
  typeof officialWorkflowCatalogDetailSchema
>;

export const officialWorkflowInstallRequestSchema = z
  .object({
    agentId: z.string().uuid(),
    blueprints: z.array(officialWorkflowBlueprintBindingsSchema),
  })
  .strict();
export type OfficialWorkflowInstallRequest = z.infer<
  typeof officialWorkflowInstallRequestSchema
>;

export const officialWorkflowReconfigureRequestSchema = z
  .object({
    blueprints: z.array(officialWorkflowBlueprintBindingsSchema).min(1),
  })
  .strict();
export type OfficialWorkflowReconfigureRequest = z.infer<
  typeof officialWorkflowReconfigureRequestSchema
>;

export const officialWorkflowInstallationDefinitionSchema = z
  .object({
    name: workflowNameSchema,
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    lifecycle: officialWorkflowLifecycleSchema,
    blueprints: z.array(officialWorkflowAcceptedBlueprintSchema),
  })
  .strict();
export type OfficialWorkflowInstallationDefinition = z.infer<
  typeof officialWorkflowInstallationDefinitionSchema
>;

export const officialWorkflowInstallationResponseSchema = z
  .object({
    workflow: workflowDetailResponseSchema,
    // New App -> old API fallback. Current APIs always return authoritative
    // accepted Definition metadata; remove the optional parser in #29991
    // after pre-P4 APIs are no longer serving or retained for rollback.
    definition: officialWorkflowInstallationDefinitionSchema.optional(),
  })
  .strict();
export type OfficialWorkflowInstallationResponse = z.infer<
  typeof officialWorkflowInstallationResponseSchema
>;

const definitionNameParams = z.object({ definitionName: workflowNameSchema });
const workflowIdParams = z.object({ workflowId: z.string().uuid() });

export const officialWorkflowsContract = c.router({
  list: {
    method: "GET",
    path: "/api/official-workflows",
    headers: authHeadersSchema,
    responses: {
      200: z.array(officialWorkflowCatalogSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List active Official Workflows",
  },
  get: {
    method: "GET",
    path: "/api/official-workflows/:definitionName",
    headers: authHeadersSchema,
    pathParams: definitionNameParams,
    responses: {
      200: officialWorkflowCatalogDetailSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get one retained Official Workflow Definition",
  },
  install: {
    method: "POST",
    path: "/api/official-workflows/:definitionName/install",
    headers: authHeadersSchema,
    pathParams: definitionNameParams,
    body: officialWorkflowInstallRequestSchema,
    responses: {
      201: officialWorkflowInstallationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Install an active Official Workflow on an agent",
  },
});

export const officialWorkflowInstallationsContract = c.router({
  get: {
    method: "GET",
    path: "/api/official-workflow-installations/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: officialWorkflowInstallationResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Inspect an Official Workflow installation",
  },
  reconfigure: {
    method: "PATCH",
    path: "/api/official-workflow-installations/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: officialWorkflowReconfigureRequestSchema,
    responses: {
      200: officialWorkflowInstallationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Reconfigure Official Workflow installation parameters",
  },
  uninstall: {
    method: "DELETE",
    path: "/api/official-workflow-installations/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Uninstall an Official Workflow",
  },
});

export type OfficialWorkflowsContract = typeof officialWorkflowsContract;
export type OfficialWorkflowInstallationsContract =
  typeof officialWorkflowInstallationsContract;
