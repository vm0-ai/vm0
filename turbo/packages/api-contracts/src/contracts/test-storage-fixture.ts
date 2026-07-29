import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  fileEntryWithHashSchema,
  presignedUploadSchema,
  storageChangesSchema,
} from "./storages";

const c = initContract();

const storageOwnerSchema = z.enum(["organization", "user"]);
const prepareResponseSchema = z.object({
  versionId: z.string(),
  existing: z.boolean(),
  uploads: z
    .object({
      archive: presignedUploadSchema,
      manifest: presignedUploadSchema,
    })
    .optional(),
});
const commitResponseSchema = z.object({
  success: z.literal(true),
  versionId: z.string(),
  headVersionId: z.string(),
  storageName: z.string(),
  size: z.number(),
  fileCount: z.number(),
  deduplicated: z.boolean().optional(),
});
const downloadResponseSchema = z.union([
  z.object({
    url: z.url(),
    versionId: z.string(),
    fileCount: z.number(),
    size: z.number(),
  }),
  z.object({
    empty: z.literal(true),
    versionId: z.string(),
    fileCount: z.literal(0),
    size: z.literal(0),
  }),
]);

export const testStorageStateActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prepare"),
    orgId: z.string(),
    userId: z.string(),
    storageName: z.string().min(1),
    storageOwner: storageOwnerSchema,
    files: z.array(fileEntryWithHashSchema),
    force: z.boolean().optional(),
    baseVersion: z.string().optional(),
    changes: storageChangesSchema.optional(),
  }),
  z.object({
    action: z.literal("commit"),
    orgId: z.string(),
    userId: z.string(),
    storageName: z.string().min(1),
    storageOwner: storageOwnerSchema,
    versionId: z.string().min(1),
    files: z.array(fileEntryWithHashSchema),
    message: z.string().optional(),
  }),
  z.object({
    action: z.literal("list"),
    orgId: z.string(),
    userId: z.string(),
    storageOwner: storageOwnerSchema,
  }),
  z.object({
    action: z.literal("download"),
    orgId: z.string(),
    userId: z.string(),
    storageName: z.string().min(1),
    storageOwner: storageOwnerSchema,
    versionId: z.string().optional(),
  }),
]);

export const testStorageStateActionResponseSchema = z.object({
  ok: z.literal(true),
  prepared: prepareResponseSchema.optional(),
  committed: commitResponseSchema.optional(),
  storages: z
    .array(
      z.object({
        name: z.string(),
        size: z.number(),
        fileCount: z.number(),
        updatedAt: z.string(),
      }),
    )
    .optional(),
  download: downloadResponseSchema.optional(),
});

export const testStorageFixtureContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/test/storage-fixture/prepare",
    headers: authHeadersSchema,
    body: z.object({
      storageName: z.string().min(1, "Storage name is required"),
      storageOwner: storageOwnerSchema,
      files: z.array(fileEntryWithHashSchema),
      force: z.boolean().optional(),
    }),
    responses: {
      200: prepareResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare a preview-only Storage fixture",
  },
  commit: {
    method: "POST",
    path: "/api/test/storage-fixture/commit",
    headers: authHeadersSchema,
    body: z.object({
      storageName: z.string().min(1, "Storage name is required"),
      storageOwner: storageOwnerSchema,
      versionId: z.string().min(1, "Version ID is required"),
      files: z.array(fileEntryWithHashSchema),
    }),
    responses: {
      200: commitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Commit a preview-only Storage fixture",
  },
  action: {
    method: "POST",
    path: "/api/test/storage-fixture/action",
    body: testStorageStateActionBodySchema,
    responses: {
      200: testStorageStateActionResponseSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Mutate and read in-process Storage API test support state",
  },
});

export type TestStorageFixtureContract = typeof testStorageFixtureContract;
export type TestStorageStateActionBody = z.infer<
  typeof testStorageStateActionBodySchema
>;
export type TestStorageStateActionResponse = z.infer<
  typeof testStorageStateActionResponseSchema
>;
