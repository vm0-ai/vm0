import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const uploadResponseSchema = z.object({
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
 * Zero contract for POST /api/zero/uploads
 *
 * Handles multipart/form-data file uploads with validation.
 * Uses FormData body for binary file transmission.
 */
export const zeroUploadsContract = c.router({
  upload: {
    method: "POST",
    path: "/api/zero/uploads",
    headers: authHeadersSchema,
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: uploadResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Upload a file",
  },
});

export type ZeroUploadsContract = typeof zeroUploadsContract;

// Inferred types
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
