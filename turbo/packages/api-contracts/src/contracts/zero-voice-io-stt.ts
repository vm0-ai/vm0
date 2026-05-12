import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroVoiceIoSttResponseSchema = z.object({
  text: z.string(),
});

export const zeroVoiceIoSttQuotaErrorSchema = apiErrorSchema.extend({
  quota: z
    .object({
      count: z.number(),
      limit: z.number().nullable(),
    })
    .optional(),
});

export type ZeroVoiceIoSttResponse = z.infer<
  typeof zeroVoiceIoSttResponseSchema
>;

export const zeroVoiceIoSttContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/voice-io/stt",
    headers: authHeadersSchema,
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: zeroVoiceIoSttResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: zeroVoiceIoSttQuotaErrorSchema,
      403: apiErrorSchema,
      429: zeroVoiceIoSttQuotaErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Transcribe audio input",
  },
});

export type ZeroVoiceIoSttContract = typeof zeroVoiceIoSttContract;
