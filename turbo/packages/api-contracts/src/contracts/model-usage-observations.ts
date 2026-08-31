import { z } from "zod";

const modelUsageObservationItemSchema = z
  .object({
    idempotencyKey: z.uuid(),
    model: z.string().min(1).max(255),
    inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cacheReadInputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cacheCreationInputTokens: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (event) => {
      return (
        event.inputTokens > 0 ||
        event.outputTokens > 0 ||
        event.cacheReadInputTokens > 0 ||
        event.cacheCreationInputTokens > 0
      );
    },
    { message: "At least one token counter must be positive" },
  );

export const modelUsageObservationEventsSchema = z
  .array(modelUsageObservationItemSchema)
  .min(1)
  .max(100)
  .superRefine((events, ctx) => {
    const idempotencyKeys = new Set<string>();
    events.forEach((event, index) => {
      if (idempotencyKeys.has(event.idempotencyKey)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "idempotencyKey"],
          message: "Idempotency keys must be unique within a request",
        });
      }
      idempotencyKeys.add(event.idempotencyKey);
    });
  });
