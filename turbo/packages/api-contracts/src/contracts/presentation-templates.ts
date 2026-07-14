import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const presentationTemplateAccessScopeSchema = z.enum([
  "private",
  "organization",
]);

export const presentationTemplateImportStatusSchema = z.enum([
  "uploading",
  "queued",
  "processing",
  "succeeded",
  "failed",
]);

export const presentationTemplateImportSchema = z.object({
  id: z.string().uuid(),
  status: presentationTemplateImportStatusSchema,
  sourceFilename: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  canRetry: z.boolean(),
  resultRevisionId: z.string().uuid().nullable(),
  createdAt: z.string(),
  uploadCommittedAt: z.string().nullable(),
  processingStartedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const presentationTemplateRevisionSchema = z.object({
  id: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  compilerVersion: z.string(),
  slideCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdAt: z.string(),
});

export const presentationTemplateSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  accessScope: presentationTemplateAccessScopeSchema,
  activeRevision: presentationTemplateRevisionSchema.nullable(),
  latestImport: presentationTemplateImportSchema.nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canManage: z.boolean(),
});

const templateParamsSchema = z.object({ id: z.string().uuid() });
const importParamsSchema = z.object({
  id: z.string().uuid(),
  importId: z.string().uuid(),
});
const revisionParamsSchema = z.object({
  id: z.string().uuid(),
  revisionId: z.string().uuid(),
});

const templateErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
} as const;

export const presentationTemplatesContract = c.router({
  create: {
    method: "POST",
    path: "/api/presentation-templates",
    headers: authHeadersSchema,
    body: z
      .object({
        name: z.string().trim().min(1).max(256),
        description: z.string().trim().max(2000).nullable().optional(),
      })
      .strict(),
    responses: { 201: presentationTemplateSchema, ...templateErrorResponses },
    summary: "Create a presentation template identity",
  },
  list: {
    method: "GET",
    path: "/api/presentation-templates",
    headers: authHeadersSchema,
    query: z.object({ includeArchived: z.coerce.boolean().optional() }),
    responses: {
      200: z.object({ templates: z.array(presentationTemplateSchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List presentation templates visible to the current user",
  },
  get: {
    method: "GET",
    path: "/api/presentation-templates/:id",
    headers: authHeadersSchema,
    pathParams: templateParamsSchema,
    responses: { 200: presentationTemplateSchema, ...templateErrorResponses },
    summary: "Get a presentation template",
  },
  update: {
    method: "PATCH",
    path: "/api/presentation-templates/:id",
    headers: authHeadersSchema,
    pathParams: templateParamsSchema,
    body: z
      .object({
        name: z.string().trim().min(1).max(256).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        accessScope: presentationTemplateAccessScopeSchema.optional(),
      })
      .strict()
      .refine((body) => {
        return Object.keys(body).length > 0;
      }, "At least one field is required"),
    responses: { 200: presentationTemplateSchema, ...templateErrorResponses },
    summary: "Update presentation template metadata or access scope",
  },
  prepareImport: {
    method: "POST",
    path: "/api/presentation-templates/:id/imports/prepare",
    headers: authHeadersSchema,
    pathParams: templateParamsSchema,
    body: z
      .object({
        filename: z.string().trim().min(1).max(512),
        contentType: z.string().trim().min(1).max(200),
        size: z
          .number()
          .int()
          .positive()
          .max(100 * 1024 * 1024),
        confirmsRights: z.literal(true),
      })
      .strict(),
    responses: {
      200: z.object({
        import: presentationTemplateImportSchema,
        uploadUrl: z.string().url(),
      }),
      ...templateErrorResponses,
    },
    summary: "Prepare a direct PPTX upload for a presentation template",
  },
  commitImport: {
    method: "POST",
    path: "/api/presentation-templates/:id/imports/:importId/commit",
    headers: authHeadersSchema,
    pathParams: importParamsSchema,
    body: z.object({}).strict(),
    responses: {
      202: presentationTemplateImportSchema,
      ...templateErrorResponses,
    },
    summary: "Commit an uploaded PPTX and queue template compilation",
  },
  listImports: {
    method: "GET",
    path: "/api/presentation-templates/:id/imports",
    headers: authHeadersSchema,
    pathParams: templateParamsSchema,
    responses: {
      200: z.object({ imports: z.array(presentationTemplateImportSchema) }),
      ...templateErrorResponses,
    },
    summary: "List presentation template imports",
  },
  retryImport: {
    method: "POST",
    path: "/api/presentation-templates/:id/imports/:importId/retry",
    headers: authHeadersSchema,
    pathParams: importParamsSchema,
    body: z.object({}).strict(),
    responses: {
      202: presentationTemplateImportSchema,
      ...templateErrorResponses,
    },
    summary: "Retry compilation for a failed immutable import",
  },
  listRevisions: {
    method: "GET",
    path: "/api/presentation-templates/:id/revisions",
    headers: authHeadersSchema,
    pathParams: templateParamsSchema,
    responses: {
      200: z.object({ revisions: z.array(presentationTemplateRevisionSchema) }),
      ...templateErrorResponses,
    },
    summary: "List successful presentation template revisions",
  },
  activateRevision: {
    method: "POST",
    path: "/api/presentation-templates/:id/revisions/:revisionId/activate",
    headers: authHeadersSchema,
    pathParams: revisionParamsSchema,
    body: z.object({}).strict(),
    responses: { 200: presentationTemplateSchema, ...templateErrorResponses },
    summary: "Activate a successful presentation template revision",
  },
  preview: {
    method: "GET",
    path: "/api/presentation-templates/:id/revisions/:revisionId/previews/:index",
    headers: authHeadersSchema,
    pathParams: revisionParamsSchema.extend({
      index: z.coerce.number().int().nonnegative(),
    }),
    responses: {
      200: z.object({ url: z.string().url() }),
      ...templateErrorResponses,
    },
    summary: "Get an authorized short-lived template preview URL",
  },
  archive: {
    method: "POST",
    path: "/api/presentation-templates/:id/archive",
    headers: authHeadersSchema,
    pathParams: templateParamsSchema,
    body: z.object({ archived: z.boolean() }).strict(),
    responses: { 200: presentationTemplateSchema, ...templateErrorResponses },
    summary: "Archive or restore a presentation template",
  },
  delete: {
    method: "DELETE",
    path: "/api/presentation-templates/:id",
    headers: authHeadersSchema,
    pathParams: templateParamsSchema,
    body: z.undefined(),
    responses: { 204: z.undefined(), ...templateErrorResponses },
    summary: "Soft-delete a presentation template",
  },
});

export type PresentationTemplatesContract =
  typeof presentationTemplatesContract;
export type PresentationTemplate = z.infer<typeof presentationTemplateSchema>;
export type PresentationTemplateImport = z.infer<
  typeof presentationTemplateImportSchema
>;
export type PresentationTemplateRevision = z.infer<
  typeof presentationTemplateRevisionSchema
>;
