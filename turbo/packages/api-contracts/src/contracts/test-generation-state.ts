import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testGenerationStateErrorSchema = z.object({
  error: z.string(),
});

export const testGenerationStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
});

const pricingRowSchema = z.object({
  kind: z.string(),
  provider: z.string(),
  category: z.string(),
  unit_price: z.number(),
  unit_size: z.number(),
});

const uploadedFileRowSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  source: z.string(),
  external_id: z.string(),
  user_id: z.string(),
  org_id: z.string().nullable(),
  filename: z.string().nullable(),
  content_type: z.string().nullable(),
  size_bytes: z.number().nullable(),
  url: z.string().nullable(),
  metadata: z.unknown(),
});

const usageEventRowSchema = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  idempotency_key: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  kind: z.string(),
  provider: z.string(),
  category: z.string(),
  quantity: z.number(),
  credits_charged: z.number().nullable(),
  status: z.string(),
  billing_error: z.string().nullable(),
});

const generationJobRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  run_id: z.string().nullable(),
  request: z.unknown(),
  result: z.unknown().nullable(),
  error: z.unknown().nullable(),
});

const behaviorCountRowSchema = z.object({
  behavior_key: z.string(),
  count: z.number(),
});

const pricingFilterSchema = z.object({
  kind: z.string(),
  provider: z.string(),
  categories: z.array(z.string()),
});

const fixtureInputSchema = testGenerationStateFixtureSchema;

export const testGenerationStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-fixture"),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
      credits: z.number().optional(),
      tier: z.string().optional(),
    }),
    z.object({
      action: z.literal("delete-fixture"),
      fixture: fixtureInputSchema,
    }),
    z.object({
      action: z.literal("upsert-pricing-rows"),
      rows: z.array(pricingRowSchema),
    }),
    z.object({
      action: z.literal("ensure-pricing-row"),
      row: pricingRowSchema,
    }),
    z.object({
      action: z.literal("delete-pricing-rows"),
      filter: pricingFilterSchema,
    }),
    z.object({
      action: z.literal("restore-pricing-rows"),
      rows: z.array(pricingRowSchema),
    }),
    z.object({
      action: z.literal("read-uploaded-files"),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
      external_id: z.string().optional(),
    }),
    z.object({
      action: z.literal("read-usage-events"),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
      run_id: z.string().optional(),
      kind: z.string().optional(),
      provider: z.string().optional(),
      category: z.string().optional(),
    }),
    z.object({
      action: z.literal("read-generation-jobs"),
      id: z.string().optional(),
      org_id: z.string().optional(),
      user_id: z.string().optional(),
    }),
    z.object({
      action: z.literal("read-org-credits"),
      org_id: z.string(),
    }),
    z.object({
      action: z.literal("seed-behavior-count"),
      org_id: z.string(),
      user_id: z.string(),
      behavior_key: z.string(),
      count: z.number(),
    }),
    z.object({
      action: z.literal("seed-run-built-in-admissions"),
      run_id: z.string(),
      entries: z.array(
        z.object({
          kind: z.string(),
          status: z.string().optional(),
          expires_at: z.string(),
        }),
      ),
    }),
    z.object({
      action: z.literal("read-behavior-counts"),
      org_id: z.string(),
      user_id: z.string(),
      behavior_key: z.string().optional(),
    }),
  ],
);

export const testGenerationStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testGenerationStateFixtureSchema.optional(),
  pricing_rows: z.array(pricingRowSchema).optional(),
  inserted: z.boolean().optional(),
  uploaded_files: z.array(uploadedFileRowSchema).optional(),
  usage_events: z.array(usageEventRowSchema).optional(),
  generation_jobs: z.array(generationJobRowSchema).optional(),
  org_credits: z.number().nullable().optional(),
  behavior_counts: z.array(behaviorCountRowSchema).optional(),
});

export const testGenerationStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/generation-state/action",
    body: testGenerationStateActionBodySchema,
    responses: {
      200: testGenerationStateActionResponseSchema,
      400: testGenerationStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read generation API test support state",
  },
});

export type TestGenerationStateContract = typeof testGenerationStateContract;
export type TestGenerationStateFixture = z.infer<
  typeof testGenerationStateFixtureSchema
>;
export type TestGenerationStateActionBody = z.infer<
  typeof testGenerationStateActionBodySchema
>;
export type TestGenerationStateActionResponse = z.infer<
  typeof testGenerationStateActionResponseSchema
>;
export type TestGenerationStatePricingRow = z.infer<typeof pricingRowSchema>;
export type TestGenerationStateUploadedFileRow = z.infer<
  typeof uploadedFileRowSchema
>;
export type TestGenerationStateUsageEventRow = z.infer<
  typeof usageEventRowSchema
>;
export type TestGenerationStateGenerationJobRow = z.infer<
  typeof generationJobRowSchema
>;
export type TestGenerationStateBehaviorCountRow = z.infer<
  typeof behaviorCountRowSchema
>;
