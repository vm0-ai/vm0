import { z } from "zod";

export const slackChatCallbackPayloadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  chatMessageId: z.string(),
});
