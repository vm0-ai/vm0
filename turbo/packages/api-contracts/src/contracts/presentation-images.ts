import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const presentationImageOrientationSchema = z.enum([
  "landscape",
  "portrait",
  "squarish",
]);

export const presentationImageResolveItemSchema = z
  .object({
    path: z.string().min(1).max(300),
    query: z.string().trim().min(1).max(160),
    intent: z.string().trim().min(1).max(200).optional(),
    orientation: presentationImageOrientationSchema.optional(),
  })
  .strict();

export const presentationImageResolveRequestSchema = z
  .object({
    items: z.array(presentationImageResolveItemSchema).min(1).max(40),
  })
  .strict();

export const presentationImageAssetSchema = z
  .object({
    src: z.url(),
    alt: z.string().min(1),
    source: z.enum(["unsplash", "pexels"]),
    sourceName: z.enum(["Unsplash", "Pexels"]),
    sourceUrl: z.url(),
    // Credit link for the source, rendered by the deck templates as the
    // "/ <sourceName>" hyperlink. Named `unsplashUrl` for backward compatibility
    // with the presentation runbook packages that whitelist this field; it now
    // carries the source link for whichever provider resolved the image.
    unsplashUrl: z.url(),
    photographerName: z.string().min(1),
    photographerUrl: z.url(),
    license: z.enum(["Unsplash", "Pexels"]),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    color: z.string().min(1).optional(),
    blurHash: z.string().min(1).optional(),
  })
  .strict();

export const presentationImageResolveErrorSchema = z
  .object({
    code: z.enum(["NO_RESULTS", "DOWNLOAD_TRACKING_FAILED", "PROVIDER_ERROR"]),
    message: z.string().min(1),
  })
  .strict();

export const presentationImageResolvedItemSchema = z
  .object({
    path: z.string(),
    query: z.string(),
    status: z.literal("resolved"),
    asset: presentationImageAssetSchema,
  })
  .strict();

export const presentationImageUnresolvedItemSchema = z
  .object({
    path: z.string(),
    query: z.string(),
    status: z.literal("unresolved"),
    error: presentationImageResolveErrorSchema,
  })
  .strict();

export const presentationImageResolveResponseSchema = z
  .object({
    items: z.array(
      z.discriminatedUnion("status", [
        presentationImageResolvedItemSchema,
        presentationImageUnresolvedItemSchema,
      ]),
    ),
  })
  .strict();

export type PresentationImageResolveRequest = z.infer<
  typeof presentationImageResolveRequestSchema
>;
export type PresentationImageResolveItem = z.infer<
  typeof presentationImageResolveItemSchema
>;
export type PresentationImageAsset = z.infer<
  typeof presentationImageAssetSchema
>;
export type PresentationImageResolveResponse = z.infer<
  typeof presentationImageResolveResponseSchema
>;

export const presentationImagesContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/presentation/images/resolve",
    headers: authHeadersSchema,
    body: presentationImageResolveRequestSchema,
    responses: {
      200: presentationImageResolveResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Resolve presentation image briefs through a server-side provider",
  },
});

export type PresentationImagesContract = typeof presentationImagesContract;
