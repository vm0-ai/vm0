import { z } from "zod";

export const triggerLoopCallbackPayloadSchema = z
  .object({
    triggerId: z.string(),
  })
  .passthrough();

export const triggerCronCallbackPayloadSchema = z
  .object({
    triggerId: z.string(),
    timezone: z.string(),
    cronExpression: z.string().optional(),
  })
  .passthrough();

export type TriggerLoopCallbackPayload = z.infer<
  typeof triggerLoopCallbackPayloadSchema
>;
export type TriggerCronCallbackPayload = z.infer<
  typeof triggerCronCallbackPayloadSchema
>;
