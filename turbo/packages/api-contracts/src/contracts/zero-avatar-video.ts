import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { zeroBuiltInGenerationAcceptedResponseSchema } from "./zero-built-in-generation";

const c = initContract();

export const avatarVideoAspectRatioSchema = z.enum([
  "portrait",
  "landscape",
  "square",
]);
export const avatarVideoScreenStyleSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export const avatarVideoVoiceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const zeroAvatarVideoGenerateRequestSchema = z
  .object({
    avatarId: z.number().int().positive(),
    voiceId: avatarVideoVoiceIdSchema,
    script: z.string().trim().min(1).optional(),
    audioUrl: z.url().optional(),
    aspectRatio: avatarVideoAspectRatioSchema.optional(),
    screenStyle: avatarVideoScreenStyleSchema.optional(),
    caption: z.boolean().optional(),
    videoName: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) => {
      return Boolean(value.script) !== Boolean(value.audioUrl);
    },
    {
      message: "Provide exactly one of script or audioUrl",
    },
  );

export const zeroAvatarVideoGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  provider: z.literal("joggai"),
  model: z.literal("joggai-talking-avatar"),
  providerVideoId: z.string(),
  avatarId: z.number().int().positive(),
  voiceId: z.string(),
  inputType: z.enum(["script", "audio"]),
  aspectRatio: avatarVideoAspectRatioSchema,
  screenStyle: avatarVideoScreenStyleSchema,
  caption: z.boolean(),
  sourceUrl: z.url(),
});

export const zeroAvatarVideoAvatarSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  videoUrl: z.url().optional(),
  coverUrl: z.url().optional(),
  aspectRatio: z.number().int().optional(),
  style: z.string().optional(),
  gender: z.string().optional(),
  age: z.string().optional(),
});

export const zeroAvatarVideoVoiceSchema = z.object({
  id: avatarVideoVoiceIdSchema,
  name: z.string(),
  sampleUrl: z.url().optional(),
  language: z.string().optional(),
  gender: z.string().optional(),
  age: z.string().optional(),
  accent: z.string().optional(),
  useCase: z.string().optional(),
});

export const zeroAvatarVideoAvatarsResponseSchema = z.object({
  avatars: z.array(zeroAvatarVideoAvatarSchema),
});
export const zeroAvatarVideoVoicesResponseSchema = z.object({
  voices: z.array(zeroAvatarVideoVoiceSchema),
  hasMore: z.boolean(),
  filterOptions: z
    .object({
      languages: z.array(z.string().min(1)),
      useCases: z.array(z.string().min(1)),
    })
    .optional(),
});

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const zeroAvatarVideoAvatarsQuerySchema = pageQuerySchema.extend({
  aspectRatio: avatarVideoAspectRatioSchema.optional(),
  style: z.enum(["professional", "social"]).optional(),
  gender: z.enum(["female", "male"]).optional(),
  age: z.enum(["adult", "senior", "young_adult"]).optional(),
  scene: z
    .enum([
      "lifestyle",
      "outdoors",
      "business",
      "studio",
      "health_fitness",
      "education",
      "news",
    ])
    .optional(),
  ethnicity: z
    .enum([
      "european",
      "african",
      "south_asian",
      "east_asian",
      "middle_eastern",
      "south_american",
      "north_american",
    ])
    .optional(),
});

export const zeroAvatarVideoVoicesQuerySchema = pageQuerySchema.extend({
  gender: z.enum(["female", "male"]).optional(),
  language: z.string().min(1).optional(),
  age: z.enum(["young", "middle_aged", "old"]).optional(),
  useCase: z.string().min(1).optional(),
});

export type ZeroAvatarVideoGenerateRequest = z.infer<
  typeof zeroAvatarVideoGenerateRequestSchema
>;
export type ZeroAvatarVideoGenerateResponse = z.infer<
  typeof zeroAvatarVideoGenerateResponseSchema
>;
export type ZeroAvatarVideoAvatarsQuery = z.infer<
  typeof zeroAvatarVideoAvatarsQuerySchema
>;
export type ZeroAvatarVideoVoicesQuery = z.infer<
  typeof zeroAvatarVideoVoicesQuerySchema
>;
export type ZeroAvatarVideoAvatar = z.infer<typeof zeroAvatarVideoAvatarSchema>;
export type ZeroAvatarVideoVoice = z.infer<typeof zeroAvatarVideoVoiceSchema>;

export const zeroAvatarVideoContract = c.router({
  generate: {
    method: "POST",
    path: "/api/zero/avatar-video/generate",
    headers: authHeadersSchema,
    body: zeroAvatarVideoGenerateRequestSchema,
    responses: {
      200: zeroAvatarVideoGenerateResponseSchema,
      202: zeroBuiltInGenerationAcceptedResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      504: apiErrorSchema,
    },
    summary: "Generate and persist a JoggAI talking-avatar video",
  },
  avatars: {
    method: "GET",
    path: "/api/zero/avatar-video/avatars",
    headers: authHeadersSchema,
    query: zeroAvatarVideoAvatarsQuerySchema,
    responses: {
      200: zeroAvatarVideoAvatarsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List public JoggAI avatars",
  },
  voices: {
    method: "GET",
    path: "/api/zero/avatar-video/voices",
    headers: authHeadersSchema,
    query: zeroAvatarVideoVoicesQuerySchema,
    responses: {
      200: zeroAvatarVideoVoicesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List public JoggAI voices",
  },
});

export type ZeroAvatarVideoContract = typeof zeroAvatarVideoContract;
