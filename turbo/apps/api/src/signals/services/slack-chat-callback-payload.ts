import { z } from "zod";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";

export const slackChatCallbackPayloadSchema = z.object({
  channelId: z.string(),
  threadTs: z.string(),
  routeThreadTs: z.string().optional(),
  chatEventId: z.string(),
  /**
   * Persisted callbacks written before #28795 do not carry the webhook brand
   * and can outlive API promotion while their run drains for up to two hours.
   * Remove this optionality and the delivery fallback together after #28937
   * verifies that old callbacks and retained rollback writers have drained.
   */
  publicBrand: publicBrandSchema.optional(),
});
