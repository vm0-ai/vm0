import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testMemoryStateErrorSchema = z.object({
  error: z.string(),
});

export const testMemoryStateFixtureSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
});

const memoryActivityItemSeedSchema = z.object({
  file_path: z.string(),
  diff: z.unknown().optional(),
});

const memorySummaryRowSchema = z.object({
  id: z.string(),
  date: z.string(),
  from_version_id: z.string().nullable(),
  to_version_id: z.string(),
  summary: z.string().nullable(),
});

export const testMemoryStateActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed-fixture"),
  }),
  z.object({
    action: z.literal("delete-fixture"),
    fixture: testMemoryStateFixtureSchema,
  }),
  z.object({
    action: z.literal("seed-activity-summary"),
    org_id: z.string(),
    user_id: z.string(),
    date: z.string(),
    from_version_id: z.string().nullable().optional(),
    to_version_id: z.string(),
    summary: z.string().nullable().optional(),
    items: z.array(memoryActivityItemSeedSchema).optional(),
  }),
  z.object({
    action: z.literal("seed-storage"),
    org_id: z.string(),
    user_id: z.string(),
    s3_key: z.string(),
    head_version_id: z.string().nullable().optional(),
    size: z.number().optional(),
    file_count: z.number().optional(),
    updated_at: z.string().optional(),
    type: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    action: z.literal("seed-version"),
    storage_id: z.string(),
    version_id: z.string(),
    s3_key: z.string(),
    user_id: z.string(),
    created_at: z.string(),
  }),
  z.object({
    action: z.literal("update-version-created-at"),
    version_id: z.string(),
    created_at: z.string(),
  }),
  z.object({
    action: z.literal("read-storage-id"),
    org_id: z.string(),
  }),
  z.object({
    action: z.literal("read-summary"),
    org_id: z.string(),
    user_id: z.string(),
    date: z.string(),
  }),
  z.object({
    action: z.literal("read-summaries"),
    org_id: z.string(),
    user_id: z.string(),
  }),
  z.object({
    action: z.literal("read-items"),
    summary_id: z.string(),
  }),
]);

export const testMemoryStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testMemoryStateFixtureSchema.optional(),
  summary_id: z.string().optional(),
  storage_id: z.string().optional(),
  head_version_id: z.string().nullable().optional(),
  summary: memorySummaryRowSchema.nullable().optional(),
  summaries: z.array(memorySummaryRowSchema).optional(),
  file_paths: z.array(z.string()).optional(),
});

export const testMemoryStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/memory-state/action",
    body: testMemoryStateActionBodySchema,
    responses: {
      200: testMemoryStateActionResponseSchema,
      400: testMemoryStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read memory API test support state",
  },
});

export type TestMemoryStateContract = typeof testMemoryStateContract;
export type TestMemoryStateFixture = z.infer<
  typeof testMemoryStateFixtureSchema
>;
export type TestMemoryStateActionBody = z.infer<
  typeof testMemoryStateActionBodySchema
>;
export type TestMemoryStateActionResponse = z.infer<
  typeof testMemoryStateActionResponseSchema
>;
export type TestMemoryStateSummaryRow = z.infer<typeof memorySummaryRowSchema>;
