import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const nullableDateStringSchema = z.string().nullable();
const optionalDateStringSchema = z.string().optional();

const testUsageInsightStateErrorSchema = z.object({
  error: z.string(),
});

export const testUsageInsightStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
});

const usageInsightFixtureInputSchema = testUsageInsightStateFixtureSchema;

const bonusUsageEventSchema = z.object({
  kind: z.string(),
  provider: z.string(),
  category: z.string(),
  quantity: z.number(),
  credits_charged: z.number(),
  status: z.string(),
});

export const testUsageInsightStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-fixture"),
    }),
    z.object({
      action: z.literal("delete-fixture"),
      fixture: usageInsightFixtureInputSchema,
    }),
    z.object({
      action: z.literal("seed-compose"),
      org_id: z.string(),
      user_id: z.string(),
      name: z.string().optional(),
      display_name: z.string().nullable().optional(),
      visibility: z.enum(["public", "private"]).optional(),
    }),
    z.object({
      action: z.literal("seed-run"),
      org_id: z.string(),
      user_id: z.string(),
      compose_id: z.string(),
      trigger_source: z.string().optional(),
      automation_id: z.string().optional(),
      chat_thread_id: z.string().optional(),
      status: z.string().optional(),
      prompt: z.string().optional(),
      created_at: optionalDateStringSchema,
      started_at: nullableDateStringSchema.optional(),
      completed_at: nullableDateStringSchema.optional(),
      continued_from_session_id: z.string().nullable().optional(),
      sandbox_reuse_result: z.string().nullable().optional(),
      result: z.record(z.string(), z.unknown()).nullable().optional(),
      error: z.string().nullable().optional(),
      last_event_sequence: z.number().nullable().optional(),
      selected_model: z.string().nullable().optional(),
    }),
    z.object({
      action: z.literal("seed-automation"),
      org_id: z.string(),
      user_id: z.string(),
      agent_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
    }),
    z.object({
      action: z.literal("seed-chat-thread"),
      user_id: z.string(),
      compose_id: z.string(),
      title: z.string().optional(),
    }),
    z.object({
      action: z.literal("insert-model-usage-event-for-run"),
      org_id: z.string(),
      user_id: z.string(),
      run_id: z.string(),
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      credits_charged: z.number().optional(),
      status: z.string().optional(),
      processed_at: nullableDateStringSchema.optional(),
    }),
    z.object({
      action: z.literal("insert-usage-event"),
      org_id: z.string(),
      user_id: z.string().optional(),
      run_id: z.string().nullable().optional(),
      kind: z.string().optional(),
      provider: z.string().optional(),
      category: z.string().optional(),
      quantity: z.number().optional(),
      status: z.string().optional(),
      credits_charged: z.number().optional(),
      idempotency_key: z.string().optional(),
      created_at: optionalDateStringSchema,
      processed_at: nullableDateStringSchema.optional(),
    }),
    z.object({
      action: z.literal("set-usage-event-created-at"),
      id: z.string(),
      created_at: z.string(),
    }),
    z.object({
      action: z.literal("seed-automation-batch"),
      org_id: z.string(),
      user_id: z.string(),
      compose_id: z.string(),
      entries: z.array(
        z.object({
          credits: z.number(),
          bonus: bonusUsageEventSchema.nullable().optional(),
        }),
      ),
    }),
  ],
);

export const testUsageInsightStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testUsageInsightStateFixtureSchema.optional(),
  compose_id: z.string().optional(),
  agent_id: z.string().optional(),
  run_id: z.string().optional(),
  automation_id: z.string().optional(),
  chat_thread_id: z.string().optional(),
  usage_event_id: z.string().optional(),
  automation_ids: z.array(z.string()).optional(),
});

export const testUsageInsightStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/usage-insight-state/action",
    body: testUsageInsightStateActionBodySchema,
    responses: {
      200: testUsageInsightStateActionResponseSchema,
      400: testUsageInsightStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate usage insight API test support state",
  },
});

export type TestUsageInsightStateContract =
  typeof testUsageInsightStateContract;
export type TestUsageInsightStateFixture = z.infer<
  typeof testUsageInsightStateFixtureSchema
>;
export type TestUsageInsightStateActionBody = z.infer<
  typeof testUsageInsightStateActionBodySchema
>;
export type TestUsageInsightStateActionResponse = z.infer<
  typeof testUsageInsightStateActionResponseSchema
>;
