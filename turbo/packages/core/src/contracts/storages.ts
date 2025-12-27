import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Storage type enum
 */
const storageTypeSchema = z.enum(["volume", "artifact"]);

/**
 * Upload storage response schema (JSON part of POST response)
 */
const uploadStorageResponseSchema = z.object({
  name: z.string(),
  versionId: z.string(),
  size: z.number(),
  fileCount: z.number(),
  type: storageTypeSchema,
  deduplicated: z.boolean(),
});

/**
 * Storages contract for /api/storages
 *
 * Note: This API handles binary file upload/download:
 * - POST: Multipart form data upload, returns JSON
 * - GET: Query params, returns binary tar.gz file
 *
 * The contract defines the JSON parts for type safety.
 * Binary response handling is done at the route level.
 */
export const storagesContract = c.router({
  /**
   * POST /api/storages
   * Upload a storage (tar.gz file)
   *
   * Content-Type: multipart/form-data
   * Form fields:
   * - name: string (storage name, 3-64 chars, lowercase alphanumeric with hyphens)
   * - file: File (tar.gz archive)
   * - type: "volume" | "artifact" (optional, defaults to "volume")
   * - force: "true" | "false" (optional, skip deduplication)
   */
  upload: {
    method: "POST",
    path: "/api/storages",
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: uploadStorageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Upload storage archive",
  },

  /**
   * GET /api/storages
   * Download a storage as tar.gz file
   *
   * Query params:
   * - name: string (required, storage name)
   * - version: string (optional, version ID or prefix)
   *
   * Returns: Binary tar.gz file (application/gzip)
   */
  download: {
    method: "GET",
    path: "/api/storages",
    query: z.object({
      name: z.string().min(1, "Storage name is required"),
      version: z.string().optional(),
    }),
    responses: {
      // Binary response - actual handling done at route level
      200: c.otherResponse({
        contentType: "application/gzip",
        body: c.type<Blob>(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Download storage archive",
  },
});

export type StoragesContract = typeof storagesContract;

// ============================================================================
// Direct Upload Schemas (for CLI and Webhook endpoints)
// ============================================================================

/**
 * File entry with hash for content-addressable storage
 */
export const fileEntryWithHashSchema = z.object({
  path: z.string().min(1, "File path is required"),
  hash: z.string().length(64, "Hash must be SHA-256 (64 hex chars)"),
  size: z.number().int().min(0, "Size must be non-negative"),
});

/**
 * Incremental changes schema for partial uploads
 */
export const storageChangesSchema = z.object({
  added: z.array(z.string()),
  modified: z.array(z.string()),
  deleted: z.array(z.string()),
});

/**
 * Presigned upload URL schema
 */
export const presignedUploadSchema = z.object({
  key: z.string(),
  presignedUrl: z.string().url(),
});

// ============================================================================
// Direct Upload Contracts (CLI endpoints)
// ============================================================================

/**
 * Storage prepare contract for /api/storages/prepare
 *
 * Prepares for direct S3 upload by:
 * 1. Computing content hash from file metadata
 * 2. Checking for existing version (deduplication)
 * 3. Generating presigned URLs if upload needed
 */
export const storagesPrepareContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/storages/prepare",
    body: z.object({
      storageName: z.string().min(1, "Storage name is required"),
      storageType: storageTypeSchema,
      files: z.array(fileEntryWithHashSchema),
      force: z.boolean().optional(),
      runId: z.string().optional(), // For sandbox auth
      baseVersion: z.string().optional(), // For incremental uploads
      changes: storageChangesSchema.optional(),
    }),
    responses: {
      200: z.object({
        versionId: z.string(),
        existing: z.boolean(),
        uploads: z
          .object({
            archive: presignedUploadSchema,
            manifest: presignedUploadSchema,
          })
          .optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare for direct S3 upload",
  },
});

/**
 * Storage commit contract for /api/storages/commit
 *
 * Commits a direct S3 upload by:
 * 1. Verifying uploaded files exist in S3
 * 2. Creating storage version record
 * 3. Updating storage HEAD pointer
 */
export const storagesCommitContract = c.router({
  commit: {
    method: "POST",
    path: "/api/storages/commit",
    body: z.object({
      storageName: z.string().min(1, "Storage name is required"),
      storageType: storageTypeSchema,
      versionId: z.string().min(1, "Version ID is required"),
      files: z.array(fileEntryWithHashSchema),
      runId: z.string().optional(),
      message: z.string().optional(),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        versionId: z.string(),
        storageName: z.string(),
        size: z.number(),
        fileCount: z.number(),
        deduplicated: z.boolean().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema, // S3 files missing
      500: apiErrorSchema,
    },
    summary: "Commit uploaded storage",
  },
});

/**
 * Storage download contract for /api/storages/download
 *
 * Returns presigned URL for downloading storage archive from S3.
 * Different from storagesContract.download which streams the file directly.
 */
export const storagesDownloadContract = c.router({
  download: {
    method: "GET",
    path: "/api/storages/download",
    query: z.object({
      name: z.string().min(1, "Storage name is required"),
      type: storageTypeSchema,
      version: z.string().optional(),
    }),
    responses: {
      // Normal response with presigned URL
      200: z.union([
        z.object({
          url: z.string().url(),
          versionId: z.string(),
          fileCount: z.number(),
          size: z.number(),
        }),
        // Empty artifact response
        z.object({
          empty: z.literal(true),
          versionId: z.string(),
          fileCount: z.literal(0),
          size: z.literal(0),
        }),
      ]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get presigned download URL",
  },
});

export type StoragesPrepareContract = typeof storagesPrepareContract;
export type StoragesCommitContract = typeof storagesCommitContract;
export type StoragesDownloadContract = typeof storagesDownloadContract;

// Export schemas for reuse
export { storageTypeSchema, uploadStorageResponseSchema };
