import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessWithSkippedSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const scheduleLoopCallbackPayloadSchema = z
  .object({
    scheduleId: z.string(),
  })
  .passthrough();

export const scheduleCronCallbackPayloadSchema =
  scheduleLoopCallbackPayloadSchema
    .extend({
      timezone: z.string(),
      cronExpression: z.string().optional(),
    })
    .passthrough();

export const internalCallbacksScheduleContract = c.router({
  cron: {
    method: "POST",
    path: "/api/internal/callbacks/schedule/cron",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: scheduleCronCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessWithSkippedSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
    },
    summary: "Handle terminal callbacks for cron schedules",
  },
  loop: {
    method: "POST",
    path: "/api/internal/callbacks/schedule/loop",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: scheduleLoopCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessWithSkippedSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
    },
    summary: "Handle terminal callbacks for loop schedules",
  },
});

export type InternalCallbacksScheduleContract =
  typeof internalCallbacksScheduleContract;
export type ScheduleCronCallbackPayload = z.infer<
  typeof scheduleCronCallbackPayloadSchema
>;
export type ScheduleLoopCallbackPayload = z.infer<
  typeof scheduleLoopCallbackPayloadSchema
>;
