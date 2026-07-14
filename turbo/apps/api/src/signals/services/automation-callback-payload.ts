import { z } from "zod";

export const automationLoopCallbackPayloadSchema = z
  .object({
    triggerId: z.string(),
  })
  .passthrough();

export const automationCronCallbackPayloadSchema = z
  .object({
    triggerId: z.string(),
    timezone: z.string(),
    cronExpression: z.string().optional(),
  })
  .passthrough();

export type AutomationLoopCallbackPayload = z.infer<
  typeof automationLoopCallbackPayloadSchema
>;
export type AutomationCronCallbackPayload = z.infer<
  typeof automationCronCallbackPayloadSchema
>;
