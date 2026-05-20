import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { zeroBuiltInGenerationAcceptedResponseSchema } from "./zero-built-in-generation";

const c = initContract();

export const zeroWebsiteTemplateIdSchema = z.enum(["launch", "profile"]);
export const zeroWebsiteTemplateRequestSchema = z.enum([
  "auto",
  "launch",
  "profile",
]);

export const zeroWebsiteIoGenerateRequestSchema = z
  .object({
    prompt: z.unknown().optional(),
    template: z.unknown().optional(),
    imageCount: z.unknown().optional(),
    imageModel: z.unknown().optional(),
    title: z.unknown().optional(),
    audience: z.unknown().optional(),
  })
  .passthrough();

export const zeroWebsiteIoUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

export const zeroWebsiteCtaSchema = z.object({
  label: z.string(),
  href: z.string(),
});

export const zeroWebsiteHighlightSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export const zeroWebsiteSectionSchema = z.object({
  kicker: z.string(),
  title: z.string(),
  body: z.string(),
  bullets: z.array(z.string()),
});

export const zeroWebsiteStatSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const zeroWebsiteFooterSchema = z.object({
  title: z.string(),
  body: z.string(),
  cta: zeroWebsiteCtaSchema,
});

export const zeroWebsiteThemeSchema = z.object({
  accent: z.enum(["cobalt", "green", "coral", "mono"]),
  tone: z.enum(["light", "dark"]),
});

export const zeroWebsiteVisualPlacementSchema = z.enum([
  "hero",
  "feature",
  "section",
]);

export const zeroWebsiteVisualSpecSchema = z.object({
  placement: zeroWebsiteVisualPlacementSchema,
  prompt: z.string(),
  alt: z.string(),
});

export const zeroWebsiteGeneratedVisualSchema = z.object({
  placement: zeroWebsiteVisualPlacementSchema,
  url: z.string(),
  alt: z.string(),
  prompt: z.string(),
  imageId: z.string(),
  filename: z.string(),
  creditsCharged: z.number(),
});

export const zeroWebsiteSiteDataSchema = z.object({
  siteName: z.string(),
  eyebrow: z.string(),
  headline: z.string(),
  subhead: z.string(),
  primaryCta: zeroWebsiteCtaSchema,
  secondaryCta: zeroWebsiteCtaSchema,
  highlights: z.array(zeroWebsiteHighlightSchema),
  sections: z.array(zeroWebsiteSectionSchema),
  stats: z.array(zeroWebsiteStatSchema),
  footer: zeroWebsiteFooterSchema,
  theme: zeroWebsiteThemeSchema,
  visuals: z.array(zeroWebsiteVisualSpecSchema),
});

export const zeroWebsiteGenerationPayloadSchema = z.object({
  templateId: zeroWebsiteTemplateIdSchema,
  siteData: zeroWebsiteSiteDataSchema,
});

export const zeroWebsiteIoGenerateResponseSchema = z.object({
  generationId: z.string(),
  templateId: zeroWebsiteTemplateIdSchema,
  templateLabel: z.string(),
  slugSuggestion: z.string(),
  siteData: zeroWebsiteSiteDataSchema,
  creditsCharged: z.number(),
  textCreditsCharged: z.number(),
  imageCreditsCharged: z.number(),
  model: z.string(),
  imageCount: z.number(),
  imageModel: z.string(),
  imageUrls: z.array(z.string()),
  generatedVisuals: z.array(zeroWebsiteGeneratedVisualSchema),
  responseId: z.string().optional(),
  usage: zeroWebsiteIoUsageSchema,
});

export type ZeroWebsiteTemplateId = z.infer<typeof zeroWebsiteTemplateIdSchema>;
export type ZeroWebsiteTemplateRequest = z.infer<
  typeof zeroWebsiteTemplateRequestSchema
>;
export type ZeroWebsiteVisualPlacement = z.infer<
  typeof zeroWebsiteVisualPlacementSchema
>;
export type ZeroWebsiteVisualSpec = z.infer<typeof zeroWebsiteVisualSpecSchema>;
export type ZeroWebsiteGeneratedVisual = z.infer<
  typeof zeroWebsiteGeneratedVisualSchema
>;
export type ZeroWebsiteSiteData = z.infer<typeof zeroWebsiteSiteDataSchema>;
export type ZeroWebsiteGenerationPayload = z.infer<
  typeof zeroWebsiteGenerationPayloadSchema
>;
export type ZeroWebsiteIoGenerateRequest = z.infer<
  typeof zeroWebsiteIoGenerateRequestSchema
>;
export type ZeroWebsiteIoGenerateResponse = z.infer<
  typeof zeroWebsiteIoGenerateResponseSchema
>;

export const zeroWebsiteIoGenerateContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/website-io/generate",
    headers: authHeadersSchema,
    body: zeroWebsiteIoGenerateRequestSchema,
    responses: {
      200: zeroWebsiteIoGenerateResponseSchema,
      202: zeroBuiltInGenerationAcceptedResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Generate structured content for a hosted website template",
  },
});

export type ZeroWebsiteIoGenerateContract =
  typeof zeroWebsiteIoGenerateContract;
