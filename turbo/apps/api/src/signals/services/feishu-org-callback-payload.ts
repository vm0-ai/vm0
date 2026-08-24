import { z } from "zod";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";

export const feishuOrgCallbackFileSchema = z.object({
  fileId: z.string().min(1),
  messageId: z.string().min(1),
  fileKey: z.string().min(1),
  type: z.enum(["file", "image"]),
});

export const feishuOrgCallbackPayloadSchema = z
  .object({
    installationId: z.string().uuid(),
    chatId: z.string(),
    messageId: z.string(),
    connectionId: z.string(),
    sessionKey: z.string().optional(),
    agentId: z.string().uuid().optional(),
    existingSessionId: z.string().uuid().optional(),
    reactionId: z.string().optional(),
    replyInThread: z.boolean().optional(),
    files: z.array(feishuOrgCallbackFileSchema).optional(),
    canonicalChatDelivery: z.boolean().optional(),
    // #27750 rollout fallback: callbacks persisted by the previous API omit
    // the Host brand and may complete after an old runner/sandbox drains (up
    // to 2h). Remove this optional field and the installation-brand read after
    // all pre-#28935 callbacks and API rollback writers have drained.
    publicBrand: publicBrandSchema.optional(),
  })
  .passthrough();

export type FeishuOrgCallbackPayload = z.infer<
  typeof feishuOrgCallbackPayloadSchema
>;
