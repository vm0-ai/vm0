/**
 * Public API v1 - Runs Contract
 *
 * Run endpoints for executing agents and monitoring execution.
 */
import { z } from "zod";
import { authHeadersSchema, initContract } from "../base";
import {
  publicApiErrorSchema,
  createPaginatedResponseSchema,
  listQuerySchema,
  timestampSchema,
} from "./common";

const c = initContract();

/**
 * Run status enum
 */
export const publicRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

export type PublicRunStatus = z.infer<typeof publicRunStatusSchema>;

/**
 * Run schema for public API responses
 */
export const publicRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  status: publicRunStatusSchema,
  prompt: z.string(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
});

export type PublicRun = z.infer<typeof publicRunSchema>;

/**
 * Run detail schema with full results
 */
export const publicRunDetailSchema = publicRunSchema.extend({
  error: z.string().nullable(),
  executionTimeMs: z.number().nullable(),
  checkpointId: z.string().nullable(),
  sessionId: z.string().nullable(),
  artifactName: z.string().nullable(),
  artifactVersion: z.string().nullable(),
  volumes: z.record(z.string(), z.string()).optional(),
});

export type PublicRunDetail = z.infer<typeof publicRunDetailSchema>;

/**
 * Paginated runs response
 */
export const paginatedRunsSchema =
  createPaginatedResponseSchema(publicRunSchema);

/**
 * Create run request schema
 */
export const createRunRequestSchema = z.object({
  // Agent identification (one of: agent, agentId, sessionId, checkpointId)
  agent: z.string().optional(), // Agent name
  agentId: z.string().optional(), // Agent ID
  agentVersion: z.string().optional(), // Version specifier (e.g., "latest", "v1", specific ID)

  // Continue session
  sessionId: z.string().optional(),

  // Resume from checkpoint
  checkpointId: z.string().optional(),

  // Required
  prompt: z.string().min(1, "Prompt is required"),

  // Optional configuration
  variables: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  artifactName: z.string().optional(), // Artifact name to mount
  artifactVersion: z.string().optional(), // Artifact version (defaults to latest)
  volumes: z.record(z.string(), z.string()).optional(), // volume_name -> version
});

export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

/**
 * Run list query parameters
 */
export const runListQuerySchema = listQuerySchema.extend({
  agentId: z.string().optional(),
  status: publicRunStatusSchema.optional(),
  since: timestampSchema.optional(),
});

export type RunListQuery = z.infer<typeof runListQuerySchema>;

/**
 * Runs list contract - GET /v1/runs, POST /v1/runs
 */
export const publicRunsListContract = c.router({
  list: {
    method: "GET",
    path: "/v1/runs",
    headers: authHeadersSchema,
    query: runListQuerySchema,
    responses: {
      200: paginatedRunsSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List runs",
    description: "List runs with optional filtering by agent, status, and time",
  },
  create: {
    method: "POST",
    path: "/v1/runs",
    headers: authHeadersSchema,
    body: createRunRequestSchema,
    responses: {
      202: publicRunDetailSchema, // Async operation
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      429: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Create run",
    description:
      "Create and execute a new agent run. Returns 202 Accepted as runs execute asynchronously.",
  },
});

/**
 * Run by ID contract - GET /v1/runs/:id
 */
export const publicRunByIdContract = c.router({
  get: {
    method: "GET",
    path: "/v1/runs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: publicRunDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get run",
    description: "Get run details by ID",
  },
});

/**
 * Run cancel contract - POST /v1/runs/:id/cancel
 */
export const publicRunCancelContract = c.router({
  cancel: {
    method: "POST",
    path: "/v1/runs/:id/cancel",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    body: z.undefined(),
    responses: {
      200: publicRunDetailSchema,
      400: publicApiErrorSchema, // Run not in cancellable state
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Cancel run",
    description: "Cancel a pending or running execution",
  },
});

/**
 * Log entry schema
 */
export const logEntrySchema = z.object({
  timestamp: timestampSchema,
  type: z.enum(["agent", "system", "network"]),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;

/**
 * Paginated logs response
 */
export const paginatedLogsSchema =
  createPaginatedResponseSchema(logEntrySchema);

/**
 * Logs query parameters
 */
export const logsQuerySchema = listQuerySchema.extend({
  type: z.enum(["agent", "system", "network", "all"]).default("all"),
  since: timestampSchema.optional(),
  until: timestampSchema.optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});

export type LogsQuery = z.infer<typeof logsQuerySchema>;

/**
 * Run logs contract - GET /v1/runs/:id/logs
 */
export const publicRunLogsContract = c.router({
  getLogs: {
    method: "GET",
    path: "/v1/runs/:id/logs",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: logsQuerySchema,
    responses: {
      200: paginatedLogsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get run logs",
    description:
      "Get unified logs for a run. Combines agent, system, and network logs.",
  },
});

/**
 * Metric data point schema
 */
export const metricPointSchema = z.object({
  timestamp: timestampSchema,
  cpuPercent: z.number(),
  memoryUsedMb: z.number(),
  memoryTotalMb: z.number(),
  diskUsedMb: z.number(),
  diskTotalMb: z.number(),
});

export type MetricPoint = z.infer<typeof metricPointSchema>;

/**
 * Metrics summary schema
 */
export const metricsSummarySchema = z.object({
  avgCpuPercent: z.number(),
  maxMemoryUsedMb: z.number(),
  totalDurationMs: z.number().nullable(),
});

export type MetricsSummary = z.infer<typeof metricsSummarySchema>;

/**
 * Metrics response schema
 */
export const metricsResponseSchema = z.object({
  data: z.array(metricPointSchema),
  summary: metricsSummarySchema,
});

export type MetricsResponse = z.infer<typeof metricsResponseSchema>;

/**
 * Run metrics contract - GET /v1/runs/:id/metrics
 */
export const publicRunMetricsContract = c.router({
  getMetrics: {
    method: "GET",
    path: "/v1/runs/:id/metrics",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: metricsResponseSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get run metrics",
    description: "Get CPU, memory, and disk metrics for a run",
  },
});

/**
 * SSE event types
 */
export const sseEventTypeSchema = z.enum([
  "status", // Run status change
  "output", // Agent output
  "error", // Error occurred
  "complete", // Run completed
  "heartbeat", // Keep-alive
]);

export type SSEEventType = z.infer<typeof sseEventTypeSchema>;

/**
 * SSE event schema (for documentation purposes - actual events are streamed)
 */
export const sseEventSchema = z.object({
  event: sseEventTypeSchema,
  data: z.unknown(),
  id: z.string().optional(), // For Last-Event-ID reconnection
});

export type SSEEvent = z.infer<typeof sseEventSchema>;

/**
 * Run events contract - GET /v1/runs/:id/events (SSE)
 *
 * Note: This endpoint returns Server-Sent Events, not JSON.
 * The response schema is for documentation purposes.
 */
export const publicRunEventsContract = c.router({
  streamEvents: {
    method: "GET",
    path: "/v1/runs/:id/events",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      lastEventId: z.string().optional(), // For reconnection
    }),
    responses: {
      200: z.any(), // SSE stream - actual content is text/event-stream
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Stream run events",
    description:
      "Stream real-time events for a run using Server-Sent Events (SSE). Set Accept: text/event-stream header.",
  },
});

export type PublicRunsListContract = typeof publicRunsListContract;
export type PublicRunByIdContract = typeof publicRunByIdContract;
export type PublicRunCancelContract = typeof publicRunCancelContract;
export type PublicRunLogsContract = typeof publicRunLogsContract;
export type PublicRunMetricsContract = typeof publicRunMetricsContract;
export type PublicRunEventsContract = typeof publicRunEventsContract;
