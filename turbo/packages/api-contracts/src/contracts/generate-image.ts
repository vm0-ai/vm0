import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const generateImageRequestSchema = z
  .object({
    prompt: z.unknown().optional(),
  })
  .passthrough();

export const generatedImageSchema = z.object({
  mimeType: z.string(),
  base64: z.string(),
});

export const generateImageResponseSchema = z.object({
  images: z.array(generatedImageSchema),
});

export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;
export type GeneratedImage = z.infer<typeof generatedImageSchema>;
export type GenerateImageResponse = z.infer<typeof generateImageResponseSchema>;

export const generateImageContract = c.router({
  post: {
    method: "POST",
    path: "/api/generate-image",
    headers: authHeadersSchema,
    body: generateImageRequestSchema,
    responses: {
      200: generateImageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Generate images from a text prompt",
  },
});

export type GenerateImageContract = typeof generateImageContract;
