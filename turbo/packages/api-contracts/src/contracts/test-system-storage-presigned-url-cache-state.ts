import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testSystemStoragePresignedUrlCacheStateErrorSchema = z.object({
  error: z.string(),
});

const cacheRowSchema = z.object({
  cache_key: z.string(),
  bucket: z.string(),
  object_key: z.string(),
  storage_version_id: z.string(),
  public_endpoint: z.boolean(),
  ttl_seconds: z.number(),
  presigned_url: z.string(),
  expires_at: z.string(),
  refresh_after: z.string(),
  last_requested_at: z.string(),
});

const storageStateSchema = z.object({
  s3_prefix: z.string(),
  size: z.number(),
  file_count: z.number(),
  head_version_id: z.string().nullable(),
});

export const testSystemStoragePresignedUrlCacheStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("cleanup"),
      object_key_prefix: z.string(),
    }),
    z.object({
      action: z.literal("read-storage-state"),
      org_id: z.string(),
      user_id: z.string(),
      storage_name: z.string(),
    }),
    z.object({
      action: z.literal("restore-storage-state"),
      org_id: z.string(),
      user_id: z.string(),
      storage_name: z.string(),
      previous: storageStateSchema.nullable(),
    }),
    z.object({
      action: z.literal("seed-storage-version"),
      org_id: z.string(),
      user_id: z.string(),
      storage_name: z.string(),
      version_id: z.string(),
      s3_prefix: z.string(),
      s3_key: z.string(),
    }),
    z.object({
      action: z.literal("delete-storage-version"),
      org_id: z.string(),
      user_id: z.string(),
      storage_name: z.string(),
      version_id: z.string(),
    }),
    z.object({
      action: z.literal("seed-cache-row"),
      bucket: z.string(),
      object_key: z.string(),
      storage_version_id: z.string(),
      public_endpoint: z.boolean(),
      ttl_seconds: z.number(),
      presigned_url: z.string(),
      expires_at: z.string(),
      refresh_after: z.string(),
      last_requested_at: z.string().optional(),
    }),
    z.object({
      action: z.literal("read-cache-by-object-key-prefix"),
      object_key_prefix: z.string(),
    }),
  ]);

export const testSystemStoragePresignedUrlCacheStateActionResponseSchema =
  z.object({
    ok: z.literal(true),
    rows: z.array(cacheRowSchema).optional(),
    storage_state: storageStateSchema.nullable().optional(),
  });

export const testSystemStoragePresignedUrlCacheStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/system-storage-presigned-url-cache-state/action",
    body: testSystemStoragePresignedUrlCacheStateActionBodySchema,
    responses: {
      200: testSystemStoragePresignedUrlCacheStateActionResponseSchema,
      400: testSystemStoragePresignedUrlCacheStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read system storage presigned URL cache test state",
  },
});

export type TestSystemStoragePresignedUrlCacheStateContract =
  typeof testSystemStoragePresignedUrlCacheStateContract;
export type TestSystemStoragePresignedUrlCacheStateActionBody = z.infer<
  typeof testSystemStoragePresignedUrlCacheStateActionBodySchema
>;
export type TestSystemStoragePresignedUrlCacheStateActionResponse = z.infer<
  typeof testSystemStoragePresignedUrlCacheStateActionResponseSchema
>;
