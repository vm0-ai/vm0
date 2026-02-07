import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Compose job status enum
 */
export const composeJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

/**
 * Compose job result schema (when status = 'completed')
 */
export const composeJobResultSchema = z.object({
  composeId: z.string(),
  composeName: z.string(),
  versionId: z.string(),
  warnings: z.array(z.string()),
});

/**
 * Create compose job request schema
 */
export const createComposeJobRequestSchema = z.object({
  githubUrl: z.string().url().startsWith("https://github.com/"),
  overwrite: z.boolean().optional().default(false),
});

/**
 * Compose job response schema
 */
export const composeJobResponseSchema = z.object({
  jobId: z.string(),
  status: composeJobStatusSchema,
  githubUrl: z.string(),
  result: composeJobResultSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

/**
 * Compose jobs main contract (/api/compose/from-github)
 */
export const composeJobsMainContract = c.router({
  /**
   * POST /api/compose/from-github
   * Create a new compose job from GitHub URL
   */
  create: {
    method: "POST",
    path: "/api/compose/from-github",
    headers: authHeadersSchema,
    body: createComposeJobRequestSchema,
    responses: {
      201: composeJobResponseSchema,
      200: composeJobResponseSchema, // Returned when existing job found (idempotency)
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Create compose job from GitHub URL",
  },
});

/**
 * Compose jobs by ID contract (/api/compose/from-github/:jobId)
 */
export const composeJobsByIdContract = c.router({
  /**
   * GET /api/compose/from-github/:jobId
   * Get compose job status and result
   */
  getById: {
    method: "GET",
    path: "/api/compose/from-github/:jobId",
    headers: authHeadersSchema,
    pathParams: z.object({
      jobId: z.string().uuid(),
    }),
    responses: {
      200: composeJobResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get compose job status",
  },
});

/**
 * Webhook contract for compose job completion
 */
export const webhookComposeCompleteContract = c.router({
  /**
   * POST /api/webhooks/compose/complete
   * Handle compose job completion from sandbox
   */
  complete: {
    method: "POST",
    path: "/api/webhooks/compose/complete",
    headers: authHeadersSchema,
    body: z.object({
      jobId: z.string().uuid(),
      success: z.boolean(),
      // Result from CLI compose command
      result: composeJobResultSchema.optional(),
      error: z.string().optional(),
    }),
    responses: {
      200: z.object({
        success: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Handle compose job completion",
  },
});

// Export types
export type ComposeJobStatus = z.infer<typeof composeJobStatusSchema>;
export type ComposeJobResult = z.infer<typeof composeJobResultSchema>;
export type CreateComposeJobRequest = z.infer<
  typeof createComposeJobRequestSchema
>;
export type ComposeJobResponse = z.infer<typeof composeJobResponseSchema>;

export type ComposeJobsMainContract = typeof composeJobsMainContract;
export type ComposeJobsByIdContract = typeof composeJobsByIdContract;
export type WebhookComposeCompleteContract =
  typeof webhookComposeCompleteContract;
