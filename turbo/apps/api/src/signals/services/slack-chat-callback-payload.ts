import { z } from "zod";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";

export const slackChatCallbackPayloadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  routeThreadTs: z.string().optional(),
  chatEventId: z.string(),
  // Optional only for callbacks persisted before webhook-host branding.
  publicBrand: publicBrandSchema.optional(),
});
