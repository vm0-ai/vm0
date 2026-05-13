import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const voiceChatCallbackPayloadSchema = z
  .object({
    taskId: z.string(),
  })
  .passthrough();

export const internalCallbacksVoiceChatContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/voice-chat",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: voiceChatCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
      500: internalCallbackErrorSchema,
    },
    summary: "Handle callbacks for voice-chat task runs",
  },
});

export type VoiceChatCallbackPayload = z.infer<
  typeof voiceChatCallbackPayloadSchema
>;
export type InternalCallbacksVoiceChatContract =
  typeof internalCallbacksVoiceChatContract;
