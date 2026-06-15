import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const chatCallbackPayloadSchema = z
  .object({
    threadId: z.string(),
    agentId: z.string(),
  })
  .passthrough();

export const internalCallbacksChatContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/chat",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: chatCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
      500: internalCallbackErrorSchema,
    },
    summary: "Handle callbacks for web chat task runs",
  },
});

export type ChatCallbackPayload = z.infer<typeof chatCallbackPayloadSchema>;
export type InternalCallbacksChatContract =
  typeof internalCallbacksChatContract;
