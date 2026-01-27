import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  createPaginatedResponseSchema,
  listQuerySchema,
} from "./public/common";

const c = initContract();

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
 * Log entry in list response - only includes id for efficiency
 */
const platformLogEntrySchema = z.object({
  id: z.string().uuid(),
});

/**
 * Logs list response schema using standard pagination
 */
const platformLogsListResponseSchema = createPaginatedResponseSchema(
  platformLogEntrySchema,
);

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
  provider: z.string(),
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

// Contract type exports
export type PlatformLogsListContract = typeof platformLogsListContract;
export type PlatformLogsByIdContract = typeof platformLogsByIdContract;

// Schema exports for reuse
export {
  platformLogStatusSchema,
  platformLogEntrySchema,
  platformLogsListResponseSchema,
  artifactSchema,
  platformLogDetailSchema,
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

// Re-export Pagination type from common
export type { Pagination } from "./public/common";
