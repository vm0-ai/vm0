import { z } from "zod";

export const feishuOrgCallbackPayloadSchema = z
  .object({
    installationId: z.string().uuid(),
    chatId: z.string(),
    messageId: z.string(),
    connectionId: z.string(),
  })
  .passthrough();

export type FeishuOrgCallbackPayload = z.infer<
  typeof feishuOrgCallbackPayloadSchema
>;
