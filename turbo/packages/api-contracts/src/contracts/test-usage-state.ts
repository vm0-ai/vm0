import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const nullableDateStringSchema = z.string().nullable();
const optionalDateStringSchema = z.string().optional();

const testUsageStateErrorSchema = z.object({
  error: z.string(),
});

export const testUsageStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  user_ids: z.array(z.string()),
});

const usageFixtureInputSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  user_ids: z.array(z.string()),
});

export const testUsageStateActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed-fixture"),
    current_period_end: nullableDateStringSchema.optional(),
    tier: z.string().optional(),
  }),
  z.object({
    action: z.literal("delete-fixture"),
    fixture: usageFixtureInputSchema,
  }),
  z.object({
    action: z.literal("insert-usage-event"),
    org_id: z.string(),
    user_id: z.string(),
    run_id: z.string().nullable().optional(),
    kind: z.string().optional(),
    provider: z.string().optional(),
    category: z.string().optional(),
    quantity: z.number().optional(),
    credits_charged: z.number().nullable().optional(),
    status: z.string().optional(),
    created_at: optionalDateStringSchema,
    processed_at: nullableDateStringSchema.optional(),
  }),
  z.object({
    action: z.literal("insert-model-usage"),
    org_id: z.string(),
    user_id: z.string(),
    run_id: z.string().nullable().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    credits_charged: z.number().nullable().optional(),
    status: z.string().optional(),
    created_at: optionalDateStringSchema,
    processed_at: nullableDateStringSchema.optional(),
  }),
  z.object({
    action: z.literal("seed-run"),
    org_id: z.string(),
    user_id: z.string(),
    display_name: z.string().nullable().optional(),
    prompt: z.string().optional(),
    status: z.string().optional(),
    trigger_source: z.string().optional(),
    created_at: optionalDateStringSchema,
    started_at: nullableDateStringSchema.optional(),
    completed_at: nullableDateStringSchema.optional(),
  }),
  z.object({
    action: z.literal("seed-chat-thread-run"),
    org_id: z.string(),
    user_id: z.string(),
    title: z.string().nullable().optional(),
    trigger_source: z.string().optional(),
    thread_id: z.string().optional(),
    created_at: optionalDateStringSchema,
  }),
  z.object({
    action: z.literal("set-credit-balance"),
    org_id: z.string(),
    credits: z.number(),
  }),
  z.object({
    action: z.literal("seed-user-name"),
    user_id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    cached_at: z.string(),
  }),
  z.object({
    action: z.literal("seed-cached-org-member"),
    org_id: z.string(),
    user_id: z.string(),
    cached_at: z.string(),
  }),
  z.object({
    action: z.literal("seed-existing-insights"),
    org_id: z.string(),
    user_id: z.string(),
    date: z.string(),
    updated_at: z.string(),
    data: z.unknown().optional(),
  }),
]);

export const testUsageStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testUsageStateFixtureSchema.optional(),
  usage_event_id: z.string().optional(),
  run_id: z.string().optional(),
  compose_id: z.string().optional(),
  thread_id: z.string().optional(),
});

export const testUsageStateInsightsResponseSchema = z.object({
  data: z.unknown().nullable(),
});

export const testUsageStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/usage-state/action",
    body: testUsageStateActionBodySchema,
    responses: {
      200: testUsageStateActionResponseSchema,
      400: testUsageStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate usage API test support state",
  },
  insights: {
    method: "GET",
    path: "/api/test/usage-state/insights",
    query: z.object({
      org_id: z.string(),
      user_id: z.string(),
      date: z.string(),
    }),
    responses: {
      200: testUsageStateInsightsResponseSchema,
      400: testUsageStateErrorSchema,
      404: z.string(),
    },
    summary: "Read usage insights API test support state",
  },
});

export type TestUsageStateContract = typeof testUsageStateContract;
export type TestUsageStateFixture = z.infer<typeof testUsageStateFixtureSchema>;
export type TestUsageStateActionBody = z.infer<
  typeof testUsageStateActionBodySchema
>;
export type TestUsageStateActionResponse = z.infer<
  typeof testUsageStateActionResponseSchema
>;
export type TestUsageStateInsightsResponse = z.infer<
  typeof testUsageStateInsightsResponseSchema
>;
