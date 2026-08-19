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

const mutationResponseSchema = z.object({
  id: z.uuid(),
  status: presentationTemplateStatusSchema,
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
  commit: {
    method: "POST",
    path: "/api/okou/presentation-templates/commit",
    headers: authHeadersSchema,
    body: commitPresentationTemplateBodySchema,
    responses: {
      200: mutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Commit the uploaded PPTX and its ordered page image references",
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
export type CommitPresentationTemplateBody = z.infer<
  typeof commitPresentationTemplateBodySchema
>;
