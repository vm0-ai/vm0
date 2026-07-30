import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const prepareRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  /**
   * New clients opt in to applying headers returned with a presigned upload.
   * Older API deployments ignore this field, while newer APIs keep returning
   * legacy object keys to clients that omit it.
   */
  supportsUploadHeaders: z.literal(true).optional(),
  /**
   * New clients request multipart uploads for large files. Older API
   * deployments ignore this unknown field and return the legacy single PUT
   * response, which keeps frontend/backend rolling deploys compatible.
   */
  multipart: z.literal(true).optional(),
});

const importImageRequestSchema = z.object({
  url: z.string().url(),
});

const uploadMetadataSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  /** Public CDN URL returned to the app after upload succeeds. */
  url: z.string().url(),
});

const prepareResponseSchema = uploadMetadataSchema.extend({
  /** Presigned PUT URL — browser uploads the file body here directly. */
  uploadUrl: z.string().url(),
  /** Headers the client must include with the presigned PUT request. */
  uploadHeaders: z.record(z.string(), z.string()).optional(),
});

const multipartUploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  uploadUrl: z.string().url(),
});

const multipartPrepareResponseSchema = uploadMetadataSchema.extend({
  multipart: z.object({
    uploadId: z.string().min(1),
    partSize: z.number().int().positive(),
    parts: z.array(multipartUploadPartSchema).min(1),
  }),
});

const prepareResultSchema = z.union([
  prepareResponseSchema,
  multipartPrepareResponseSchema,
]);

const multipartUploadIdentitySchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  uploadId: z.string().min(1),
});

const multipartCompleteRequestSchema = multipartUploadIdentitySchema.extend({
  partCount: z.number().int().min(1).max(1000),
});

const multipartResponseSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
});

const multipartAbortResponseSchema = z.object({
  id: z.string().uuid(),
});

const completeRequestSchema = z.object({
  id: z.string().uuid(),
  contentType: z.string().min(1).max(200).optional(),
});

const completeResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string().url(),
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Zero contract for uploads.
 *
 * `prepare` issues a presigned PUT URL so the browser can send the file body
 * straight to R2, bypassing the Next.js runtime's body-size limits. `complete`
 * confirms the object exists after the PUT and persists run associations when
 * the request is authenticated with a run-scoped zero token.
 */
export const zeroUploadsContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/zero/uploads/prepare",
    headers: authHeadersSchema,
    body: prepareRequestSchema,
    responses: {
      200: prepareResultSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare a direct-to-R2 upload",
  },
  completeMultipart: {
    method: "POST",
    path: "/api/zero/uploads/multipart/complete",
    headers: authHeadersSchema,
    body: multipartCompleteRequestSchema,
    responses: {
      200: multipartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete a multipart R2 upload",
  },
  abortMultipart: {
    method: "POST",
    path: "/api/zero/uploads/multipart/abort",
    headers: authHeadersSchema,
    body: multipartUploadIdentitySchema,
    responses: {
      200: multipartAbortResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Abort a multipart R2 upload",
  },
  complete: {
    method: "POST",
    path: "/api/zero/uploads/complete",
    headers: authHeadersSchema,
    body: completeRequestSchema,
    responses: {
      200: completeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete a direct-to-R2 upload",
  },
  importImage: {
    method: "POST",
    path: "/api/zero/uploads/import-image",
    headers: authHeadersSchema,
    body: importImageRequestSchema,
    responses: {
      200: completeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Import a remote image into user artifact storage",
  },
});

export type ZeroUploadsContract = typeof zeroUploadsContract;

// Inferred types
export type UploadPrepareResponse = z.infer<typeof prepareResultSchema>;
export type UploadCompleteResponse = z.infer<typeof completeResponseSchema>;
export type UploadImportImageResponse = z.infer<typeof completeResponseSchema>;
