import { z } from "zod";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";

export const slackChatCallbackPayloadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  routeThreadTs: z.string().optional(),
  chatEventId: z.string(),
  publicBrand: publicBrandSchema,
});
