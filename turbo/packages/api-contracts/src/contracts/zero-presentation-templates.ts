import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PAGES = 100;
export const PRESENTATION_TEMPLATE_CONVERSION_TIMEOUT_SECONDS = 10 * 60;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES = 512 * 1024;

export const presentationTemplateStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed",
]);

export const presentationTemplateImportErrorCodeSchema = z.enum([
  "too_many_pages",
  "conversion_timeout",
  "render_failed",
  "analysis_failed",
  "publish_failed",
]);

export const presentationTemplatePreflightErrorCodeSchema = z.enum([
  "unsupported_format",
  "invalid_file",
  "encrypted_file",
  "too_large",
]);

const presentationTemplateErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const presentationTemplateSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: presentationTemplateStatusSchema,
  error: presentationTemplateErrorSchema.nullable(),
  sourceFilename: z.string(),
  coverUrl: z.string().url().nullable(),
  pageCount: z.number().int().nonnegative(),
  aspectRatio: z.number().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const presentationTemplateDetailSchema =
  presentationTemplateSummarySchema.extend({
    pageUrls: z.array(z.string().url()),
  });

const presentationTemplateIdParamsSchema = z.object({
  templateId: z.uuid(),
});

const createPresentationTemplateBodySchema = z.object({
  uploadId: z.uuid(),
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(200),
});

const updatePresentationTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
});

const sourceResponseSchema = z.object({
  url: z.string().url(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});

const preparePagesBodySchema = z.object({
  count: z.number().int().min(1).max(MAX_PRESENTATION_TEMPLATE_PAGES),
});

const pageUploadSchema = z.object({
  key: z.string().min(1),
  uploadUrl: z.string().url(),
  uploadHeaders: z.record(z.string(), z.string()),
});

const commitPagesBodySchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(MAX_PRESENTATION_TEMPLATE_PAGES),
  aspectRatio: z.number().positive().max(10),
});

const packagePathSchema = z.enum([
  "DESIGN_SYSTEM.md",
  "LAYOUTS.md",
  "tokens.json",
]);

const packageFileSchema = z.object({
  path: packagePathSchema,
  content: z.string().refine(
    (content) => {
      return (
        new TextEncoder().encode(content).byteLength <=
        MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES
      );
    },
    {
      message: `Package files must be ${MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES.toString()} UTF-8 bytes or smaller`,
    },
  ),
});

const publishPackageBodySchema = z
  .object({
    files: z.array(packageFileSchema).length(packagePathSchema.options.length),
  })
  .refine(
    ({ files }) => {
      return (
        new Set(
          files.map((file) => {
            return file.path;
          }),
        ).size === files.length
      );
    },
    { message: "Package must contain each required file exactly once" },
  );

const failImportBodySchema = z.object({
  code: presentationTemplateImportErrorCodeSchema,
  message: z.string().trim().min(1).max(2000),
});

const mutationResponseSchema = z.object({
  id: z.uuid(),
  status: presentationTemplateStatusSchema,
});

export const zeroPresentationTemplatesContract = c.router({
  list: {
    method: "GET",
    path: "/api/okou/presentation-templates",
    headers: authHeadersSchema,
    responses: {
      200: z.array(presentationTemplateSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List presentation templates owned by the current user",
  },
  create: {
    method: "POST",
    path: "/api/okou/presentation-templates",
    headers: authHeadersSchema,
    body: createPresentationTemplateBodySchema,
    responses: {
      201: presentationTemplateSummarySchema,
      400: apiErrorSchema,
      402: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create and start importing a presentation template",
  },
  get: {
    method: "GET",
    path: "/api/okou/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: presentationTemplateDetailSchema,
      404: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get a presentation template",
  },
  update: {
    method: "PATCH",
    path: "/api/okou/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: updatePresentationTemplateBodySchema,
    responses: {
      200: presentationTemplateSummarySchema,
      404: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Rename a presentation template",
  },
  delete: {
    method: "DELETE",
    path: "/api/okou/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      404: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a presentation template",
  },
  source: {
    method: "GET",
    path: "/api/okou/presentation-templates/:templateId/source",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: sourceResponseSchema,
      404: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare a presentation template source download",
  },
  preparePages: {
    method: "POST",
    path: "/api/okou/presentation-templates/:templateId/pages/prepare",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: preparePagesBodySchema,
    responses: {
      200: z.object({ uploads: z.array(pageUploadSchema) }),
      404: apiErrorSchema,
      409: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare direct page image uploads",
  },
  commitPages: {
    method: "POST",
    path: "/api/okou/presentation-templates/:templateId/pages/commit",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: commitPagesBodySchema,
    responses: {
      200: mutationResponseSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Commit uploaded page images",
  },
  publishPackage: {
    method: "POST",
    path: "/api/okou/presentation-templates/:templateId/package",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: publishPackageBodySchema,
    responses: {
      200: mutationResponseSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Publish a completed presentation template package",
  },
  fail: {
    method: "POST",
    path: "/api/okou/presentation-templates/:templateId/fail",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: failImportBodySchema,
    responses: {
      200: mutationResponseSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Mark a presentation template import as failed",
  },
});

export type ZeroPresentationTemplatesContract =
  typeof zeroPresentationTemplatesContract;
export type PresentationTemplateSummary = z.infer<
  typeof presentationTemplateSummarySchema
>;
