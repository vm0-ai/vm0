import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const TRANSLATION_MAX_SOURCE_TEXT_CHARS = 16_384;
export const TRANSLATION_MAX_RESULT_TEXT_CHARS = 32_768;
export const TRANSLATION_MAX_LANGUAGE_CHARS = 64;

export const translationLanguageSchema = z
  .string()
  .trim()
  .min(1)
  .max(TRANSLATION_MAX_LANGUAGE_CHARS);

export const translationRequestSchema = z.object({
  text: z.string().trim().min(1).max(TRANSLATION_MAX_SOURCE_TEXT_CHARS),
  targetLanguage: translationLanguageSchema,
  sourceLanguage: translationLanguageSchema.optional(),
});

export const translationResponseSchema = z.object({
  text: z.string().trim().min(1).max(TRANSLATION_MAX_RESULT_TEXT_CHARS),
  metadata: z.object({
    creditsCharged: z.number().int().nonnegative(),
  }),
});

export type TranslationRequest = z.infer<typeof translationRequestSchema>;
export type TranslationResponse = z.infer<typeof translationResponseSchema>;

const translationResponses = {
  200: translationResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  500: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const translationContract = c.router({
  translate: {
    method: "POST",
    path: "/api/okou/translate",
    headers: authHeadersSchema,
    body: translationRequestSchema,
    responses: translationResponses,
    summary: "Translate text through a managed translation model",
  },
});

export type TranslationContract = typeof translationContract;
