import { z } from "zod";

export const telegramDeliveryTargetSchema = z.object({
  installationId: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  rootMessageId: z.string().nullable(),
  routeId: z.string(),
  routeCreated: z.boolean(),
  seededFromLegacy: z.boolean(),
  userLinkId: z.string(),
  userLinkKind: z.enum(["custom", "official"]),
  agentId: z.string(),
  isDM: z.boolean(),
});

export type TelegramDeliveryTarget = z.infer<
  typeof telegramDeliveryTargetSchema
>;
