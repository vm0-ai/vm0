import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroVoiceIoTtsRequestSchema = z
  .object({
    text: z.unknown().optional(),
  })
  .passthrough();

export type ZeroVoiceIoTtsRequest = z.infer<typeof zeroVoiceIoTtsRequestSchema>;

export const zeroVoiceIoTtsContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/voice-io/tts",
    headers: authHeadersSchema,
    body: zeroVoiceIoTtsRequestSchema,
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Generate PCM text-to-speech audio",
  },
});

export type ZeroVoiceIoTtsContract = typeof zeroVoiceIoTtsContract;
