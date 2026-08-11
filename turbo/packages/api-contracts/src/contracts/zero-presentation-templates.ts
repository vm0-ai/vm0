import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PAGES = 100;
export const PRESENTATION_TEMPLATE_CONVERSION_TIMEOUT_SECONDS = 10 * 60;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES = 512 * 1024;

export const PRESENTATION_TEMPLATE_PACKAGE_PATHS = [
  "DESIGN_SYSTEM.md",
  "LAYOUTS.md",
  "tokens.json",
] as const;

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

export const presentationTemplateIdSchema = z.uuid();

const presentationTemplateIdParamsSchema = z.object({
  templateId: presentationTemplateIdSchema,
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

const packagePathSchema = z.enum(PRESENTATION_TEMPLATE_PACKAGE_PATHS);

const packageFileSchema = z.object({
  path: packagePathSchema,
  content: z.string().max(MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES),
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

const commonErrors = {
  401: apiErrorSchema,
  403: apiErrorSchema,
  500: apiErrorSchema,
} as const;

export const zeroPresentationTemplatesContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/presentation-templates",
    headers: authHeadersSchema,
    responses: {
      200: z.array(presentationTemplateSummarySchema),
      ...commonErrors,
    },
    summary: "List presentation templates owned by the current user",
  },
  create: {
    method: "POST",
    path: "/api/zero/presentation-templates",
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
      ...commonErrors,
    },
    summary: "Create and start importing a presentation template",
  },
  get: {
    method: "GET",
    path: "/api/zero/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: presentationTemplateDetailSchema,
      404: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Get a presentation template",
  },
  update: {
    method: "PATCH",
    path: "/api/zero/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: updatePresentationTemplateBodySchema,
    responses: {
      200: presentationTemplateSummarySchema,
      404: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Rename a presentation template",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { 204: c.noBody(), 404: apiErrorSchema, ...commonErrors },
    summary: "Delete a presentation template",
  },
  source: {
    method: "GET",
    path: "/api/zero/presentation-templates/:templateId/source",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: sourceResponseSchema,
      404: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Prepare a presentation template source download",
  },
  preparePages: {
    method: "POST",
    path: "/api/zero/presentation-templates/:templateId/pages/prepare",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: preparePagesBodySchema,
    responses: {
      200: z.object({ uploads: z.array(pageUploadSchema) }),
      404: apiErrorSchema,
      409: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Prepare direct page image uploads",
  },
  commitPages: {
    method: "POST",
    path: "/api/zero/presentation-templates/:templateId/pages/commit",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: commitPagesBodySchema,
    responses: {
      200: mutationResponseSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Commit uploaded page images",
  },
  publishPackage: {
    method: "POST",
    path: "/api/zero/presentation-templates/:templateId/package",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: publishPackageBodySchema,
    responses: {
      200: mutationResponseSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Publish a completed presentation template package",
  },
  downloadPackage: {
    method: "GET",
    path: "/api/zero/presentation-templates/:templateId/package",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        url: z.string().url(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
      404: apiErrorSchema,
      409: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Prepare a presentation template package download",
  },
  fail: {
    method: "POST",
    path: "/api/zero/presentation-templates/:templateId/fail",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: failImportBodySchema,
    responses: {
      200: mutationResponseSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      ...commonErrors,
    },
    summary: "Mark a presentation template import as failed",
  },
});

export type ZeroPresentationTemplatesContract =
  typeof zeroPresentationTemplatesContract;
export type PresentationTemplateSummary = z.infer<
  typeof presentationTemplateSummarySchema
>;
export type PresentationTemplateImportErrorCode = z.infer<
  typeof presentationTemplateImportErrorCodeSchema
>;
export type PresentationTemplatePackagePath =
  (typeof PRESENTATION_TEMPLATE_PACKAGE_PATHS)[number];
