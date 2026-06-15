import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const audioTranscriptionV1Schema = z.object({
  text: z.string(),
});

export const audioTranscriptionsV1Contract = c.router({
  transcribe: {
    method: "POST",
    path: "/api/v1/audio/transcriptions",
    headers: authHeadersSchema,
    body: c.type<Blob>(),
    responses: {
      200: audioTranscriptionV1Schema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      413: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Transcribe raw 16 kHz mono signed 16-bit PCM audio using the existing voice input pipeline",
  },
});

export type AudioTranscriptionsV1Contract =
  typeof audioTranscriptionsV1Contract;
export type AudioTranscriptionV1 = z.infer<typeof audioTranscriptionV1Schema>;

export { audioTranscriptionV1Schema };
