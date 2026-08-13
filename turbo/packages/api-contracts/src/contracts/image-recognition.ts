import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const IMAGE_RECOGNITION_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const IMAGE_RECOGNITION_MAX_PROMPT_CHARS = 8_192;
export const IMAGE_RECOGNITION_MAX_TEXT_CHARS = 32_768;

export const imageRecognitionMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const imageRecognitionRequestSchema = z.object({
  fileId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(IMAGE_RECOGNITION_MAX_PROMPT_CHARS),
});

export const imageRecognitionResponseSchema = z.object({
  text: z.string().trim().min(1).max(IMAGE_RECOGNITION_MAX_TEXT_CHARS),
  metadata: z.object({
    creditsCharged: z.number().int().nonnegative(),
  }),
});

export type ImageRecognitionMimeType = z.infer<
  typeof imageRecognitionMimeTypeSchema
>;
export type ImageRecognitionRequest = z.infer<
  typeof imageRecognitionRequestSchema
>;
export type ImageRecognitionResponse = z.infer<
  typeof imageRecognitionResponseSchema
>;

const recognitionResponses = {
  200: imageRecognitionResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  413: apiErrorSchema,
  500: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const imageRecognitionContract = c.router({
  recognize: {
    method: "POST",
    path: "/api/okou/recognize",
    headers: authHeadersSchema,
    body: imageRecognitionRequestSchema,
    responses: recognitionResponses,
    summary: "Recognize one owned image through a managed multimodal model",
  },
});

export type ImageRecognitionContract = typeof imageRecognitionContract;
