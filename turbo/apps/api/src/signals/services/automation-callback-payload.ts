import { z } from "zod";

function validateAutomationIdentifier(
  payload: {
    readonly automationId?: string;
    readonly triggerId?: string;
  },
  context: z.RefinementCtx,
): void {
  if (payload.automationId === undefined && payload.triggerId === undefined) {
    context.addIssue({
      code: "custom",
      message: "automationId or triggerId is required",
    });
    return;
  }
  if (
    payload.automationId !== undefined &&
    payload.triggerId !== undefined &&
    payload.automationId !== payload.triggerId
  ) {
    context.addIssue({
      code: "custom",
      message: "automationId and triggerId must match",
    });
  }
}

export const automationLoopCallbackPayloadSchema = z
  .object({
    automationId: z.string().optional(),
    triggerId: z.string().optional(),
  })
  .passthrough()
  .superRefine(validateAutomationIdentifier)
  .transform((payload) => {
    return {
      ...payload,
      automationId: payload.automationId ?? payload.triggerId,
    };
  })
  .pipe(
    z
      .object({
        automationId: z.string(),
        triggerId: z.string().optional(),
      })
      .passthrough(),
  );

export const automationCronCallbackPayloadSchema = z
  .object({
    automationId: z.string().optional(),
    triggerId: z.string().optional(),
    timezone: z.string(),
    cronExpression: z.string().optional(),
  })
  .passthrough()
  .superRefine(validateAutomationIdentifier)
  .transform((payload) => {
    return {
      ...payload,
      automationId: payload.automationId ?? payload.triggerId,
    };
  })
  .pipe(
    z
      .object({
        automationId: z.string(),
        triggerId: z.string().optional(),
        timezone: z.string(),
        cronExpression: z.string().optional(),
      })
      .passthrough(),
  );

export type AutomationLoopCallbackPayload = z.infer<
  typeof automationLoopCallbackPayloadSchema
>;
export type AutomationCronCallbackPayload = z.infer<
  typeof automationCronCallbackPayloadSchema
>;
