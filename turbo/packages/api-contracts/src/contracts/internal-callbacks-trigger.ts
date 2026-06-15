import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessWithSkippedSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const triggerLoopCallbackPayloadSchema = z
  .object({
    triggerId: z.string(),
  })
  .passthrough();

export const triggerCronCallbackPayloadSchema = triggerLoopCallbackPayloadSchema
  .extend({
    timezone: z.string(),
    cronExpression: z.string().optional(),
  })
  .passthrough();

/**
 * Completion callbacks for `automation_triggers` time rows. The poller
 * claims a due trigger by
 * clearing `next_run_at`; this callback advances the recurrence after the run
 * finishes and owns the consecutive-failure bookkeeping (reset on success,
 * increment on failure, auto-disable at the threshold).
 */
export const internalCallbacksTriggerContract = c.router({
  cron: {
    method: "POST",
    path: "/api/internal/callbacks/trigger/cron",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: triggerCronCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessWithSkippedSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
    },
    summary: "Handle terminal callbacks for cron/once automation triggers",
  },
  loop: {
    method: "POST",
    path: "/api/internal/callbacks/trigger/loop",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: triggerLoopCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessWithSkippedSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
    },
    summary: "Handle terminal callbacks for loop automation triggers",
  },
});

export type InternalCallbacksTriggerContract =
  typeof internalCallbacksTriggerContract;
export type TriggerCronCallbackPayload = z.infer<
  typeof triggerCronCallbackPayloadSchema
>;
export type TriggerLoopCallbackPayload = z.infer<
  typeof triggerLoopCallbackPayloadSchema
>;
