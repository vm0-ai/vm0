import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const idempotencyKeysSchema = z.array(z.uuid()).min(1);
const modelStatKeysSchema = z
  .array(
    z.object({
      hour_start: z.iso.datetime(),
      model: z.string(),
    }),
  )
  .min(1);

const modelStatsObservationFixtureSchema = z.object({
  idempotency_key: z.uuid(),
  model: z.string(),
  input_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cache_read_input_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cache_creation_input_tokens: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER),
  observed_at: z.iso.datetime(),
  aggregated_at: z.iso.datetime().nullable(),
});

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
      action: z.literal("aggregate-fixture"),
      processed_at: z.iso.datetime(),
      observation_idempotency_keys: idempotencyKeysSchema,
      stat_keys: modelStatKeysSchema,
      cleanup_batch_size: z.number().int().positive().optional(),
      cleanup_max_batches: z.number().int().positive().optional(),
    }),
    z.object({
      action: z.literal("read-fixture-rankings"),
      period: z.string().optional(),
      now: z.iso.datetime(),
      stat_keys: modelStatKeysSchema,
    }),
    z.object({
      action: z.literal("insert-observations"),
      observations: z.array(modelStatsObservationFixtureSchema).min(1),
    }),
    z.object({
      action: z.literal("insert-applied-observations"),
      idempotency_keys: idempotencyKeysSchema,
      model: z.string(),
      observed_at: z.iso.datetime(),
      aggregated_at: z.iso.datetime(),
    }),
    z.object({
      action: z.literal("delete-observations"),
      idempotency_keys: idempotencyKeysSchema,
    }),
    z.object({
      action: z.literal("delete-fixture"),
      idempotency_keys: idempotencyKeysSchema,
      stat_keys: modelStatKeysSchema,
    }),
  ],
);

const testModelStatsObservationSchema = z.object({
  idempotency_key: z.uuid(),
  aggregated_at: z.iso.datetime().nullable(),
});

const modelStatsAggregationResultSchema = z.object({
  cutoff: z.iso.datetime(),
  processed_hours: z.number().int().nonnegative(),
  processed_observations: z.number().int().nonnegative(),
  updated_stats: z.number().int().nonnegative(),
  deleted_observations: z.number().int().nonnegative(),
});

const modelStatsRankingResultSchema = z.object({
  period: z.enum(["today", "week", "month"]),
  total_tokens: z.number().int().nonnegative(),
  window_start: z.iso.datetime(),
  window_end: z.iso.datetime(),
  rows: z.array(
    z.object({
      model: z.string(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      previous_total_tokens: z.number().int().nonnegative(),
    }),
  ),
});

export const testModelStatsStateActionResponseSchema = z.object({
  ok: z.literal(true),
  aggregation_lock_held: z.boolean().optional(),
  aggregation_lock_waiter_count: z.number().int().nonnegative().optional(),
  observation_lock_held: z.boolean().optional(),
  observations: z.array(testModelStatsObservationSchema).optional(),
  aggregation: modelStatsAggregationResultSchema.optional(),
  ranking: modelStatsRankingResultSchema.optional(),
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
