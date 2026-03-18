import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

/**
 * Cursor-based pagination schema with total pages
 */
export const paginationSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  totalPages: z.number(),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Common query parameters for list endpoints
 */
const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const c = initContract();

/**
 * Run status enum for logs
 */
const logStatusSchema = z.enum([
  "queued",
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
const logEntrySchema = z.object({
  id: z.uuid(),
  sessionId: z.string().nullable(),
  agentName: z.string(),
  displayName: z.string().nullable(),
  orgSlug: z.string().nullable(),
  framework: z.string().nullable(),
  status: logStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/**
 * Logs list response schema with pagination
 */
const logsListResponseSchema = z.object({
  data: z.array(logEntrySchema),
  pagination: paginationSchema,
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
const logDetailSchema = z.object({
  id: z.uuid(),
  sessionId: z.string().nullable(),
  agentName: z.string(),
  displayName: z.string().nullable(),
  framework: z.string().nullable(),
  status: logStatusSchema,
  prompt: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  artifact: artifactSchema,
});

/**
 * Logs list contract
 * GET /api/app/logs
 */
export const logsListContract = c.router({
  list: {
    method: "GET",
    path: "/api/app/logs",
    query: listQuerySchema.extend({
      search: z.string().optional(),
      agent: z.string().optional(),
      name: z.string().optional(),
      org: z.string().optional(),
      status: logStatusSchema.optional(),
    }),
    responses: {
      200: logsListResponseSchema,
      401: apiErrorSchema,
    },
    summary: "List agent run logs with pagination",
  },
});

/**
 * Logs by ID contract
 * GET /api/app/logs/:id
 */
export const logsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/app/logs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid("Invalid log ID"),
    }),
    responses: {
      200: logDetailSchema,
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
  url: z.url(),
  expiresAt: z.string(),
});

/**
 * Artifact download contract
 * GET /api/app/artifacts/download
 * Returns a presigned URL for downloading the artifact
 */
export const artifactDownloadContract = c.router({
  getDownloadUrl: {
    method: "GET",
    path: "/api/app/artifacts/download",
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
export type LogsListContract = typeof logsListContract;
export type LogsByIdContract = typeof logsByIdContract;
export type ArtifactDownloadContract = typeof artifactDownloadContract;

// Schema exports for reuse
export {
  logStatusSchema,
  logEntrySchema,
  logsListResponseSchema,
  artifactSchema,
  logDetailSchema,
  artifactDownloadResponseSchema,
};

// Inferred type exports
export type LogStatus = z.infer<typeof logStatusSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type LogsListResponse = z.infer<typeof logsListResponseSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type LogDetail = z.infer<typeof logDetailSchema>;
export type ArtifactDownloadResponse = z.infer<
  typeof artifactDownloadResponseSchema
>;
