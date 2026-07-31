import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const idempotencyKeysSchema = z.array(z.uuid()).min(1);

export const testModelStatsStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("hold-aggregation-lock"),
    }),
    z.object({
      action: z.literal("read-aggregation-lock-state"),
    }),
    z.object({
      action: z.literal("release-aggregation-lock"),
    }),
    z.object({
      action: z.literal("hold-observation-lock"),
      idempotency_key: z.uuid(),
    }),
    z.object({
      action: z.literal("read-observation-lock-state"),
    }),
    z.object({
      action: z.literal("release-observation-lock"),
    }),
    z.object({
      action: z.literal("read-observations"),
      idempotency_keys: idempotencyKeysSchema,
    }),
    z.object({
      action: z.literal("insert-zero-token-observation"),
      idempotency_key: z.uuid(),
      model: z.string(),
      observed_at: z.iso.datetime(),
    }),
    z.object({
      action: z.literal("delete-observations"),
      idempotency_keys: idempotencyKeysSchema,
    }),
    z.object({
      action: z.literal("delete-fixture"),
      idempotency_keys: idempotencyKeysSchema,
      models: z.array(z.string()).min(1),
      window_start: z.iso.datetime(),
      window_end: z.iso.datetime(),
    }),
  ],
);

const testModelStatsObservationSchema = z.object({
  idempotency_key: z.uuid(),
  aggregated_at: z.iso.datetime().nullable(),
});

export const testModelStatsStateActionResponseSchema = z.object({
  ok: z.literal(true),
  aggregation_lock_held: z.boolean().optional(),
  aggregation_lock_waiter_count: z.number().int().nonnegative().optional(),
  observation_lock_held: z.boolean().optional(),
  observations: z.array(testModelStatsObservationSchema).optional(),
});

export const testModelStatsStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/model-stats-state/action",
    body: testModelStatsStateActionBodySchema,
    responses: {
      200: testModelStatsStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Manage model stats API test support state",
  },
});

export type TestModelStatsStateActionBody = z.infer<
  typeof testModelStatsStateActionBodySchema
>;
export type TestModelStatsStateActionResponse = z.infer<
  typeof testModelStatsStateActionResponseSchema
>;
