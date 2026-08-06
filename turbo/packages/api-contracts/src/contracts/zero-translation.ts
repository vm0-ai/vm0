import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS = 16_384;
export const ZERO_TRANSLATION_MAX_RESULT_TEXT_CHARS = 32_768;
export const ZERO_TRANSLATION_MAX_LANGUAGE_CHARS = 64;

export const zeroTranslationLanguageSchema = z
  .string()
  .trim()
  .min(1)
  .max(ZERO_TRANSLATION_MAX_LANGUAGE_CHARS);

export const zeroTranslationRequestSchema = z.object({
  text: z.string().trim().min(1).max(ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS),
  targetLanguage: zeroTranslationLanguageSchema,
  sourceLanguage: zeroTranslationLanguageSchema.optional(),
});

export const zeroTranslationResponseSchema = z.object({
  text: z.string().trim().min(1).max(ZERO_TRANSLATION_MAX_RESULT_TEXT_CHARS),
  metadata: z.object({
    creditsCharged: z.number().int().nonnegative(),
  }),
});

export type ZeroTranslationRequest = z.infer<
  typeof zeroTranslationRequestSchema
>;
export type ZeroTranslationResponse = z.infer<
  typeof zeroTranslationResponseSchema
>;

const translationResponses = {
  200: zeroTranslationResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  500: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroTranslationContract = c.router({
  translate: {
    method: "POST",
    path: "/api/zero/translate",
    headers: authHeadersSchema,
    body: zeroTranslationRequestSchema,
    responses: translationResponses,
    summary: "Translate text through a managed translation model",
  },
});

export type ZeroTranslationContract = typeof zeroTranslationContract;
