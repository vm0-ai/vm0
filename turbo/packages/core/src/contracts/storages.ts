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

// Export schemas for reuse
export { storageTypeSchema, uploadStorageResponseSchema };
