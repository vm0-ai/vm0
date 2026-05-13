import { z } from "zod";

export const internalCallbackHeadersSchema = z.object({
  "x-vm0-signature": z.string().optional(),
  "x-vm0-timestamp": z.string().optional(),
});

export const internalCallbackBodySchema = z
  .object({
    callbackId: z.string().optional(),
    runId: z.string().optional(),
    status: z.enum(["completed", "failed", "progress"]),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

export const internalCallbackSuccessSchema = z.object({
  success: z.literal(true),
});

export const internalCallbackErrorSchema = z.object({
  error: z.string(),
});

export type InternalCallbackBody = z.infer<typeof internalCallbackBodySchema>;
