import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testStorageArchiveSizeBackfillStateErrorSchema = z.object({
  error: z.string(),
});

const storageVersionSeedSchema = z.object({
  id: z.string().min(1).max(64),
  storage_name: z.string().min(1).max(256),
  s3_key: z.string().min(1),
  file_count: z.number().int().nonnegative(),
  archive_size: z.number().int().safe().nullable(),
});

const storageArchiveSizeBackfillWorkRowSchema = z.object({
  claim_token: z.string().uuid(),
  lease_expires_at: z.string().datetime(),
  attempt_count: z.number().int().positive(),
  outcome: z.enum(["missing", "invalid", "failed"]).nullable(),
  error_code: z.string().nullable(),
});

const storageVersionStateSchema = z.object({
  id: z.string(),
  archive_size: z.number().nullable(),
  file_count: z.number().int().nonnegative(),
  work: storageArchiveSizeBackfillWorkRowSchema.nullable(),
});

export const testStorageArchiveSizeBackfillStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("seed"),
      versions: z.array(storageVersionSeedSchema).min(1),
    }),
    z.object({
      action: z.literal("read"),
      version_ids: z.array(z.string().min(1).max(64)),
    }),
    z.object({
      action: z.literal("expire-claims"),
      version_ids: z.array(z.string().min(1).max(64)).min(1),
    }),
    z.object({
      action: z.literal("set-archive-size"),
      version_id: z.string().min(1).max(64),
      archive_size: z.number().int().safe().nonnegative(),
    }),
    z.object({
      action: z.literal("cleanup"),
      storage_name_prefix: z.string().min(1).max(256),
    }),
    z.object({
      action: z.literal("retire-temporary-tables"),
    }),
    z.object({
      action: z.literal("restore-temporary-tables"),
    }),
  ]);

export const testStorageArchiveSizeBackfillStateActionResponseSchema = z.object(
  {
    ok: z.literal(true),
    versions: z.array(storageVersionStateSchema).optional(),
  },
);

export const testStorageArchiveSizeBackfillStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/storage-archive-size-backfill-state/action",
    body: testStorageArchiveSizeBackfillStateActionBodySchema,
    responses: {
      200: testStorageArchiveSizeBackfillStateActionResponseSchema,
      400: testStorageArchiveSizeBackfillStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read storage archive size backfill test state",
  },
});

export type TestStorageArchiveSizeBackfillStateActionBody = z.infer<
  typeof testStorageArchiveSizeBackfillStateActionBodySchema
>;
export type TestStorageArchiveSizeBackfillVersionSeed = z.infer<
  typeof storageVersionSeedSchema
>;
