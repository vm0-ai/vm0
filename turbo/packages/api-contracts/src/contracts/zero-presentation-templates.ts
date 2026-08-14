import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PAGES = 100;
export const MAX_PRESENTATION_TEMPLATE_PAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES = 500 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES = 512 * 1024;
export const PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";

export const presentationTemplateStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed",
]);

export const presentationTemplateImportErrorCodeSchema = z.enum([
  "analysis_failed",
  "publish_failed",
]);

export const presentationTemplatePreflightErrorCodeSchema = z.enum([
  "unsupported_format",
  "invalid_file",
  "encrypted_file",
  "too_large",
  "invalid_upload",
  "page_count_mismatch",
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

const preparePresentationTemplateBodySchema = z
  .object({
    requestId: z.uuid(),
    filename: z.string().trim().min(1).max(255),
    sourceSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES),
    pageSizes: z
      .array(z.number().int().min(1).max(MAX_PRESENTATION_TEMPLATE_PAGE_BYTES))
      .min(1)
      .max(MAX_PRESENTATION_TEMPLATE_PAGES),
  })
  .superRefine(({ pageSizes }, context) => {
    const totalPageBytes = pageSizes.reduce((total, size) => {
      return total + size;
    }, 0);
    if (totalPageBytes > MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["pageSizes"],
        message: `Page images must total ${MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES.toString()} bytes or fewer`,
      });
    }
  });

const uploadTargetSchema = z.object({
  uploadUrl: z.string().url(),
  uploadHeaders: z.record(z.string(), z.string()),
});

const preparePresentationTemplateResponseSchema = z.object({
  templateId: z.uuid(),
  source: uploadTargetSchema,
  pages: z.array(
    uploadTargetSchema.extend({
      index: z.number().int().nonnegative(),
      filename: z.string(),
    }),
  ),
});

const updatePresentationTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
});

const sourceResponseSchema = z.object({
  url: z.string().url(),
  filename: z.string(),
  contentType: z.literal(PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE),
  size: z.number().int().positive(),
});

const pageDownloadSchema = z.object({
  index: z.number().int().nonnegative(),
  filename: z.string(),
  url: z.string().url(),
  contentType: z.literal(PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE),
  size: z.number().int().positive(),
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
  prepare: {
    method: "POST",
    path: "/api/okou/presentation-templates/prepare",
    headers: authHeadersSchema,
    body: preparePresentationTemplateBodySchema,
    responses: {
      200: preparePresentationTemplateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare private PPTX and ordered page PNG uploads",
  },
  commit: {
    method: "POST",
    path: "/api/okou/presentation-templates/:templateId/commit",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: mutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Commit a complete private template ingestion and start analysis",
  },
  get: {
    method: "GET",
    path: "/api/okou/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: presentationTemplateDetailSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
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
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
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
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a presentation template and its private objects",
  },
  source: {
    method: "GET",
    path: "/api/okou/presentation-templates/:templateId/source",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: sourceResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare a run-scoped source PPTX download",
  },
  pages: {
    method: "GET",
    path: "/api/okou/presentation-templates/:templateId/pages",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: z.object({ pages: z.array(pageDownloadSchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare ordered run-scoped page PNG downloads",
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
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
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
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Mark a presentation template analysis as failed",
  },
});

export type ZeroPresentationTemplatesContract =
  typeof zeroPresentationTemplatesContract;
export type PresentationTemplateSummary = z.infer<
  typeof presentationTemplateSummarySchema
>;
export type PreparePresentationTemplateBody = z.infer<
  typeof preparePresentationTemplateBodySchema
>;
