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
});

const prepareResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  /** Presigned PUT URL — browser uploads the file body here directly. */
  uploadUrl: z.string().url(),
  /** Public CDN URL returned to the app after upload succeeds. */
  url: z.string().url(),
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
      200: prepareResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare a direct-to-R2 upload",
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
});

export type ZeroUploadsContract = typeof zeroUploadsContract;

// Inferred types
export type UploadPrepareResponse = z.infer<typeof prepareResponseSchema>;
export type UploadCompleteResponse = z.infer<typeof completeResponseSchema>;
