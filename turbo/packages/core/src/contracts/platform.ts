import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { listQuerySchema } from "./public/common";

const c = initContract();

/**
 * Platform-specific pagination schema with total pages
 */
const platformPaginationSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  totalPages: z.number(),
});

/**
 * Run status enum for platform logs
 */
const platformLogStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

/**
 * Log entry in list response - includes basic fields for list display
 */
const platformLogEntrySchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().nullable(),
  agentName: z.string(),
  framework: z.string().nullable(),
  status: platformLogStatusSchema,
  createdAt: z.string(),
});

/**
 * Logs list response schema with platform-specific pagination
 */
const platformLogsListResponseSchema = z.object({
  data: z.array(platformLogEntrySchema),
  pagination: platformPaginationSchema,
});

/**
 * Artifact information schema
 */
const artifactSchema = z.object({
  name: z.string().nullable(),
  version: z.string().nullable(),
});

/**
 * Log detail response schema
 */
const platformLogDetailSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().nullable(),
  agentName: z.string(),
  framework: z.string().nullable(),
  status: platformLogStatusSchema,
  prompt: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  artifact: artifactSchema,
});

/**
 * Platform logs list contract
 * GET /api/platform/logs
 */
export const platformLogsListContract = c.router({
  list: {
    method: "GET",
    path: "/api/platform/logs",
    query: listQuerySchema.extend({
      search: z.string().optional(),
    }),
    responses: {
      200: platformLogsListResponseSchema,
      401: apiErrorSchema,
    },
    summary: "List agent run logs with pagination",
  },
});

/**
 * Platform logs by ID contract
 * GET /api/platform/logs/:id
 */
export const platformLogsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/platform/logs/:id",
    pathParams: z.object({
      id: z.string().uuid("Invalid log ID"),
    }),
    responses: {
      200: platformLogDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run log details by ID",
  },
});

/**
 * Artifact download URL response schema
 */
const artifactDownloadResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
});

/**
 * Platform artifact download contract
 * GET /api/platform/artifacts/download
 * Returns a presigned URL for downloading the artifact
 */
export const platformArtifactDownloadContract = c.router({
  getDownloadUrl: {
    method: "GET",
    path: "/api/platform/artifacts/download",
    query: z.object({
      name: z.string().min(1, "Artifact name is required"),
      version: z.string().optional(),
    }),
    responses: {
      200: artifactDownloadResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get presigned URL for artifact download",
  },
});

// Contract type exports
export type PlatformLogsListContract = typeof platformLogsListContract;
export type PlatformLogsByIdContract = typeof platformLogsByIdContract;
export type PlatformArtifactDownloadContract =
  typeof platformArtifactDownloadContract;

// Schema exports for reuse
export {
  platformLogStatusSchema,
  platformLogEntrySchema,
  platformLogsListResponseSchema,
  artifactSchema,
  platformLogDetailSchema,
  artifactDownloadResponseSchema,
};

// Re-export pagination schema from common
export { paginationSchema } from "./public/common";

// Inferred type exports
export type PlatformLogStatus = z.infer<typeof platformLogStatusSchema>;
export type PlatformLogEntry = z.infer<typeof platformLogEntrySchema>;
export type PlatformLogsListResponse = z.infer<
  typeof platformLogsListResponseSchema
>;
export type Artifact = z.infer<typeof artifactSchema>;
export type PlatformLogDetail = z.infer<typeof platformLogDetailSchema>;
export type ArtifactDownloadResponse = z.infer<
  typeof artifactDownloadResponseSchema
>;

// Re-export Pagination type from common
export type { Pagination } from "./public/common";
