import { z } from "zod";

export const triggerCronCallbackPayloadSchema = z
  .object({
    triggerId: z.string(),
    timezone: z.string(),
    cronExpression: z.string().optional(),
  })
  .passthrough();

export type TriggerCronCallbackPayload = z.infer<
  typeof triggerCronCallbackPayloadSchema
>;
