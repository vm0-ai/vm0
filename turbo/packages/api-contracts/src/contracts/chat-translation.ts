import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { chatTranslationLanguageSchema } from "./user-preferences";

const c = initContract();

export const CHAT_TRANSLATION_MAX_SOURCE_TEXT_CHARS = 16_384;
export const CHAT_TRANSLATION_MAX_RESULT_TEXT_CHARS = 32_768;

export const chatTranslationRequestSchema = z.object({
  text: z.string().trim().min(1).max(CHAT_TRANSLATION_MAX_SOURCE_TEXT_CHARS),
  targetLanguage: chatTranslationLanguageSchema,
});

export const chatTranslationResponseSchema = z.object({
  text: z.string().trim().min(1).max(CHAT_TRANSLATION_MAX_RESULT_TEXT_CHARS),
  metadata: z.object({
    creditsCharged: z.number().int().nonnegative(),
  }),
});

export type ChatTranslationRequest = z.infer<
  typeof chatTranslationRequestSchema
>;
export type ChatTranslationResponse = z.infer<
  typeof chatTranslationResponseSchema
>;

export const chatTranslationContract = c.router({
  translate: {
    method: "POST",
    path: "/api/chat/translate",
    headers: authHeadersSchema,
    body: chatTranslationRequestSchema,
    responses: {
      200: chatTranslationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Translate selected chat text through a managed model",
  },
});

export type ChatTranslationContract = typeof chatTranslationContract;
