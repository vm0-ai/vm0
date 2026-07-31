import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_RECOGNITION_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ZERO_RECOGNITION_MAX_PROMPT_CHARS = 8_192;
export const ZERO_RECOGNITION_MAX_TEXT_CHARS = 32_768;

export const zeroRecognitionImageMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const zeroRecognitionRequestSchema = z.object({
  fileId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(ZERO_RECOGNITION_MAX_PROMPT_CHARS),
});

export const zeroRecognitionResponseSchema = z.object({
  text: z.string().trim().min(1).max(ZERO_RECOGNITION_MAX_TEXT_CHARS),
  metadata: z.object({
    creditsCharged: z.number().int().nonnegative(),
  }),
});

export type ZeroRecognitionImageMimeType = z.infer<
  typeof zeroRecognitionImageMimeTypeSchema
>;
export type ZeroRecognitionRequest = z.infer<
  typeof zeroRecognitionRequestSchema
>;
export type ZeroRecognitionResponse = z.infer<
  typeof zeroRecognitionResponseSchema
>;

const recognitionResponses = {
  200: zeroRecognitionResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  413: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroRecognitionContract = c.router({
  recognize: {
    method: "POST",
    path: "/api/zero/recognize",
    headers: authHeadersSchema,
    body: zeroRecognitionRequestSchema,
    responses: recognitionResponses,
    summary: "Recognize one owned image through a managed multimodal model",
  },
});

export type ZeroRecognitionContract = typeof zeroRecognitionContract;
