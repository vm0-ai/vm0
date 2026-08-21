import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PAGES = 100;
export const MAX_PRESENTATION_TEMPLATE_PAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES = 500 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES = 200;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES = 25 * 1024 * 1024;

/** A deck the user uploaded. Both are rendered to page images the same way. */
export const PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
] as const;
export const PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";
export const PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE = "application/gzip";

/** Guidance a later generation run reads. Assets are optional; these are not. */
export const REQUIRED_PRESENTATION_TEMPLATE_PACKAGE_FILES = [
  "SKILL.md",
  "design-system.md",
] as const;

const presentationTemplateSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
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

const updatePresentationTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
});

/**
 * Everything a finished analysis hands back, in one call.
 *
 * The ids are ordinary private uploads the run already made, so nothing here is
 * a bespoke transfer protocol. Page order is the array order, which is why the
 * whole set arrives together: a single invocation cannot pair one deck's source
 * with another deck's pages.
 */
const publishPresentationTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
  sourceFileId: z.uuid(),
  pageFileIds: z.array(z.uuid()).min(1).max(MAX_PRESENTATION_TEMPLATE_PAGES),
  packageFileId: z.uuid(),
});

export const presentationTemplatesContract = c.router({
  publish: {
    method: "POST",
    path: "/api/okou/presentation-templates",
    headers: authHeadersSchema,
    body: publishPresentationTemplateBodySchema,
    responses: {
      200: presentationTemplateSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Publish an analysed deck as a ready presentation template",
  },
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
export type PublishPresentationTemplateBody = z.infer<
  typeof publishPresentationTemplateBodySchema
>;
