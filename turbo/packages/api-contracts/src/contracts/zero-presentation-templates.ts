import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PAGES = 100;
export const MAX_PRESENTATION_TEMPLATE_PAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES = 500 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES = 256;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_ARCHIVE_BYTES =
  128 * 1024 * 1024;
export const PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";
export const PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE = "application/gzip";

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

const commitPresentationTemplateBodySchema = z
  .object({
    requestId: z.uuid(),
    sourceFileId: z.uuid(),
    pageFileIds: z.array(z.uuid()).min(1).max(MAX_PRESENTATION_TEMPLATE_PAGES),
  })
  .superRefine(({ sourceFileId, pageFileIds }, context) => {
    if (new Set(pageFileIds).size !== pageFileIds.length) {
      context.addIssue({
        code: "custom",
        path: ["pageFileIds"],
        message: "Each page upload must be referenced exactly once",
      });
    }
    if (pageFileIds.includes(sourceFileId)) {
      context.addIssue({
        code: "custom",
        path: ["pageFileIds"],
        message: "The source upload cannot also be a page upload",
      });
    }
  });

const updatePresentationTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
});

const sourceResponseSchema = z.object({
  url: z.string().url(),
  filename: z.string(),
  contentType: z.literal(PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE),
});

const pageDownloadSchema = z.object({
  index: z.number().int().nonnegative(),
  filename: z.string(),
  url: z.string().url(),
  contentType: z.literal(PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE),
});

const publishPackageBodySchema = z.object({
  archiveFileId: z.uuid(),
});

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
  commit: {
    method: "POST",
    path: "/api/okou/presentation-templates/commit",
    headers: authHeadersSchema,
    body: commitPresentationTemplateBodySchema,
    responses: {
      200: mutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Commit uploaded PPTX and ordered PNG references and start analysis",
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
    summary: "Delete a presentation template and its generated package",
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
    summary: "Validate and publish an uploaded presentation template archive",
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
export type CommitPresentationTemplateBody = z.infer<
  typeof commitPresentationTemplateBodySchema
>;
