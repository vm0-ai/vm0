import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PAGES = 100;
export const MAX_PRESENTATION_TEMPLATE_PAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES = 500 * 1024 * 1024;
export const PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";

export const presentationTemplateStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed",
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

/**
 * A caller-chosen request id makes import creation idempotent, so a repeated
 * click resolves to the same import instead of starting a second one.
 */
const createPresentationTemplateImportBodySchema = z.object({
  requestId: z.uuid(),
  sourceFilename: z.string().trim().min(1).max(255),
});

/**
 * Uploads are requested per slot. The API allocates the object and remembers
 * which import and page it belongs to, so commit never takes object ids and a
 * client cannot pair one deck's source with another deck's pages.
 */
const presentationTemplateUploadBodySchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("source"),
    filename: z.string().trim().min(1).max(255),
    contentType: z.literal(PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE),
    size: z
      .number()
      .int()
      .positive()
      .max(MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES),
  }),
  z.object({
    role: z.literal("page"),
    pageIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_PRESENTATION_TEMPLATE_PAGES - 1),
    filename: z.string().trim().min(1).max(255),
    contentType: z.literal(PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE),
    size: z.number().int().positive().max(MAX_PRESENTATION_TEMPLATE_PAGE_BYTES),
  }),
]);

const presentationTemplateUploadResponseSchema = z.object({
  uploadUrl: z.string().url(),
  uploadHeaders: z.record(z.string(), z.string()),
});

export const presentationTemplateImportErrorCodeSchema = z.enum([
  "analysis_failed",
  "publish_failed",
]);

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

const failImportBodySchema = z.object({
  code: presentationTemplateImportErrorCodeSchema,
  message: z.string().trim().min(1).max(2000),
});

const updatePresentationTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
});

const mutationResponseSchema = z.object({
  id: z.uuid(),
  status: presentationTemplateStatusSchema,
});

/**
 * Commit hands back the chat thread the analysis runs in so the caller can open
 * it. It is null only for an import committed before its thread existed, which
 * a repeated commit resolves.
 */
const commitResponseSchema = mutationResponseSchema.extend({
  chatThreadId: z.uuid().nullable(),
});

export const presentationTemplatesContract = c.router({
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
  createImport: {
    method: "POST",
    path: "/api/okou/presentation-templates/imports",
    headers: authHeadersSchema,
    body: createPresentationTemplateImportBodySchema,
    responses: {
      200: mutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Open a presentation template import and receive its template id",
  },
  requestUpload: {
    method: "POST",
    path: "/api/okou/presentation-templates/:templateId/uploads",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: presentationTemplateUploadBodySchema,
    responses: {
      200: presentationTemplateUploadResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Allocate one source or page upload slot inside an open import",
  },
  commit: {
    method: "POST",
    path: "/api/okou/presentation-templates/:templateId/commit",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: commitResponseSchema,
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
    summary: "Close an import and start its analysis in a chat thread",
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
    summary: "Delete a presentation template record",
  },
});

export type PresentationTemplatesContract =
  typeof presentationTemplatesContract;
export type PresentationTemplateSummary = z.infer<
  typeof presentationTemplateSummarySchema
>;
export type CreatePresentationTemplateImportBody = z.infer<
  typeof createPresentationTemplateImportBodySchema
>;
export type PresentationTemplateUploadBody = z.infer<
  typeof presentationTemplateUploadBodySchema
>;
