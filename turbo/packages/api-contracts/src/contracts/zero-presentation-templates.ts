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
    summary: "Abandon a pending template upload and delete its private objects",
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
