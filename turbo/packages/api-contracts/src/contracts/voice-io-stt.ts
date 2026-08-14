import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const voiceIoSttSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const voiceIoSttResponseSchema = z.object({
  text: z.string(),
  segments: z.array(voiceIoSttSegmentSchema).optional(),
});

export const voiceIoSttQuotaErrorSchema = apiErrorSchema.extend({
  quota: z
    .object({
      count: z.number(),
      limit: z.number().nullable(),
    })
    .optional(),
});

export type VoiceIoSttSegment = z.infer<typeof voiceIoSttSegmentSchema>;
export type VoiceIoSttResponse = z.infer<typeof voiceIoSttResponseSchema>;

export const voiceIoSttContract = c.router({
  post: {
    method: "POST",
    path: "/api/okou/voice-io/stt",
    headers: authHeadersSchema,
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    query: z.object({
      verbose: z.coerce.boolean().optional().default(false),
    }),
    responses: {
      200: voiceIoSttResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: voiceIoSttQuotaErrorSchema,
      403: apiErrorSchema,
      429: voiceIoSttQuotaErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Transcribe audio input",
  },
});

export type VoiceIoSttContract = typeof voiceIoSttContract;
