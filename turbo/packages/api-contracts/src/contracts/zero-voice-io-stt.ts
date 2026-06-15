import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroVoiceIoSttSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const zeroVoiceIoSttResponseSchema = z.object({
  text: z.string(),
  segments: z.array(zeroVoiceIoSttSegmentSchema).optional(),
});

export const zeroVoiceIoSttQuotaErrorSchema = apiErrorSchema.extend({
  quota: z
    .object({
      count: z.number(),
      limit: z.number().nullable(),
    })
    .optional(),
});

export type ZeroVoiceIoSttSegment = z.infer<typeof zeroVoiceIoSttSegmentSchema>;
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
    query: z.object({
      verbose: z.coerce.boolean().optional().default(false),
    }),
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
