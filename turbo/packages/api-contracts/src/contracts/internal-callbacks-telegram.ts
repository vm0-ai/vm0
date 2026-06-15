import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const telegramCallbackPayloadSchema = z
  .object({
    installationId: z.string(),
    chatId: z.string(),
    messageId: z.string(),
    rootMessageId: z.string().nullable().optional(),
    userLinkId: z.string(),
    agentId: z.string(),
    existingSessionId: z.string().nullable().optional(),
    isDM: z.boolean(),
    thinkingMessageId: z.string().nullable().optional(),
  })
  .passthrough();

export const internalCallbacksTelegramContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/telegram",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: telegramCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
      500: internalCallbackErrorSchema,
      502: internalCallbackErrorSchema,
    },
    summary: "Handle callbacks for Telegram-triggered runs",
  },
});

export type TelegramCallbackPayload = z.infer<
  typeof telegramCallbackPayloadSchema
>;
export type InternalCallbacksTelegramContract =
  typeof internalCallbacksTelegramContract;
