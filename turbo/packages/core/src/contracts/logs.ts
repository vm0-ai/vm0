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
 * Trigger source enum — how the run was initiated
 */
export const triggerSourceSchema = z.enum([
  "schedule",
  "web",
  "slack",
  "email",
  "telegram",
  "github",
  "cli",
]);

export type TriggerSource = z.infer<typeof triggerSourceSchema>;

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
  triggerSource: triggerSourceSchema.nullable(),
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
  modelProvider: z.string().nullable(),
  triggerSource: triggerSourceSchema.nullable(),
  status: logStatusSchema,
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  artifact: artifactSchema,
});

/**
 * Logs list contract
 * GET /api/zero/logs
 */
export const logsListContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/logs",
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
 * GET /api/zero/logs/:id
 */
export const logsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/zero/logs/:id",
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

// Contract type exports
export type LogsListContract = typeof logsListContract;
export type LogsByIdContract = typeof logsByIdContract;

// Schema exports for reuse
export {
  logStatusSchema,
  logEntrySchema,
  logsListResponseSchema,
  artifactSchema,
  logDetailSchema,
};

// Inferred type exports
export type LogStatus = z.infer<typeof logStatusSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type LogsListResponse = z.infer<typeof logsListResponseSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type LogDetail = z.infer<typeof logDetailSchema>;
