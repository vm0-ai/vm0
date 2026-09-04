import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  VOICE_IO_POLISH_MAX_CONTEXT_CHARS,
  VOICE_IO_POLISH_MAX_TEXT_CHARS,
} from "./voice-io-polish";
import { voiceIoSttQuotaErrorSchema } from "./voice-io-stt";

const c = initContract();

export const VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS =
  VOICE_IO_POLISH_MAX_CONTEXT_CHARS;

export const voiceIoTranscribeResponseSchema = z
  .object({
    transcript: z.string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
    polishedText: z.string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
    language: z.string().trim().min(1).max(64),
  })
  .strict();

export type VoiceIoTranscribeResponse = z.infer<
  typeof voiceIoTranscribeResponseSchema
>;

export const voiceIoTranscribeContract = c.router({
  post: {
    method: "POST",
    path: "/api/voice-io/transcribe",
    headers: authHeadersSchema,
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: voiceIoTranscribeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: voiceIoSttQuotaErrorSchema,
      403: apiErrorSchema,
      429: voiceIoSttQuotaErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Transcribe and polish a voice draft",
  },
});

export type VoiceIoTranscribeContract = typeof voiceIoTranscribeContract;
