import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroVoiceIoSpeechRequestSchema = z
  .object({
    text: z.unknown().optional(),
    voice: z.unknown().optional(),
    instructions: z.unknown().optional(),
  })
  .passthrough();

export const zeroVoiceIoSpeechResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  model: z.string(),
  voice: z.string(),
});

export type ZeroVoiceIoSpeechRequest = z.infer<
  typeof zeroVoiceIoSpeechRequestSchema
>;
export type ZeroVoiceIoSpeechResponse = z.infer<
  typeof zeroVoiceIoSpeechResponseSchema
>;

export const zeroVoiceIoSpeechContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/voice-io/speech",
    headers: authHeadersSchema,
    body: zeroVoiceIoSpeechRequestSchema,
    responses: {
      200: zeroVoiceIoSpeechResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Generate and persist WAV speech audio",
  },
});

export type ZeroVoiceIoSpeechContract = typeof zeroVoiceIoSpeechContract;
