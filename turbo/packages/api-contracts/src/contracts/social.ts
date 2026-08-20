import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const SOCIAL_TRANSCRIPT_MAX_URL_CHARS = 2_048;
export const SOCIAL_TRANSCRIPT_MAX_TEXT_CHARS = 4 * 1024 * 1024;
export const SOCIAL_TRANSCRIPT_MAX_SEGMENTS = 50_000;
export const SOCIAL_TRANSCRIPT_MAX_TIMESTAMP_CHARS = 64;
export const SOCIAL_TRANSCRIPT_MAX_LANGUAGE_CHARS = 128;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

function hasSinglePathSegment(pathname: string): boolean {
  return pathname.split("/").filter(Boolean).length === 1;
}

function isSupportedYouTubeUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    return false;
  }
  if (url.hostname === "youtu.be") {
    return hasSinglePathSegment(url.pathname);
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) {
    return false;
  }
  if (url.pathname === "/watch") {
    return Boolean(url.searchParams.get("v")?.trim());
  }
  return /^\/shorts\/[^/]+\/?$/.test(url.pathname);
}

function normalizedYouTubeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

export const socialTranscriptUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(SOCIAL_TRANSCRIPT_MAX_URL_CHARS)
  .url()
  .refine(isSupportedYouTubeUrl, {
    message: "URL must be a supported public YouTube video or Shorts URL",
  })
  .transform(normalizedYouTubeUrl);

export const socialTranscriptRequestSchema = z.object({
  url: socialTranscriptUrlSchema,
});

export const socialTranscriptSegmentSchema = z.object({
  text: z.string().max(SOCIAL_TRANSCRIPT_MAX_TEXT_CHARS),
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  timestamp: z.string().max(SOCIAL_TRANSCRIPT_MAX_TIMESTAMP_CHARS).optional(),
});

export const socialTranscriptResultSchema = z.object({
  transcript: z.string().min(1).max(SOCIAL_TRANSCRIPT_MAX_TEXT_CHARS),
  transcriptSegments: z
    .array(socialTranscriptSegmentSchema)
    .max(SOCIAL_TRANSCRIPT_MAX_SEGMENTS),
  wordCount: z.number().int().nonnegative(),
  language: z
    .string()
    .min(1)
    .max(SOCIAL_TRANSCRIPT_MAX_LANGUAGE_CHARS)
    .optional(),
});

export const socialTranscriptResponseSchema = z.object({
  requestedUrl: socialTranscriptUrlSchema,
  platform: z.literal("youtube"),
  provider: z.literal("socialkit"),
  billingCategory: z.literal("youtube.transcript"),
  billingQuantity: z.literal(1),
  creditsCharged: z.number().int().nonnegative(),
  result: socialTranscriptResultSchema,
});

export type SocialTranscriptRequest = z.infer<
  typeof socialTranscriptRequestSchema
>;
export type SocialTranscriptSegment = z.infer<
  typeof socialTranscriptSegmentSchema
>;
export type SocialTranscriptResult = z.infer<
  typeof socialTranscriptResultSchema
>;
export type SocialTranscriptResponse = z.infer<
  typeof socialTranscriptResponseSchema
>;

export const socialContract = c.router({
  transcript: {
    method: "POST",
    path: "/api/okou/social/transcript",
    headers: authHeadersSchema,
    body: socialTranscriptRequestSchema,
    responses: {
      200: socialTranscriptResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Retrieve a public YouTube transcript through managed SocialKit",
  },
});

export type SocialContract = typeof socialContract;
