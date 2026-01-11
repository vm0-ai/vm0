import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Run status enum
 */
const runStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
]);

/**
 * Unified run request schema - supports all run modes via optional parameters
 */
const unifiedRunRequestSchema = z.object({
  // High-level shortcuts (mutually exclusive with each other)
  checkpointId: z.string().optional(),
  sessionId: z.string().optional(),

  // Base parameters (can be used directly or overridden after shortcut expansion)
  agentComposeId: z.string().optional(),
  agentComposeVersionId: z.string().optional(),
  conversationId: z.string().optional(),
  artifactName: z.string().optional(),
  artifactVersion: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  volumeVersions: z.record(z.string(), z.string()).optional(),

  // Required
  prompt: z.string().min(1, "Missing prompt"),
});

/**
 * Create run response schema
 */
const createRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  sandboxId: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  executionTimeMs: z.number().optional(),
  createdAt: z.string(),
});

/**
 * Get run response schema
 */
const getRunResponseSchema = z.object({
  runId: z.string(),
  agentComposeVersionId: z.string(),
  status: runStatusSchema,
  prompt: z.string(),
  vars: z.record(z.string(), z.string()).optional(),
  sandboxId: z.string().optional(),
  result: z
    .object({
      output: z.string(),
      executionTimeMs: z.number(),
    })
    .optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

/**
 * Run event schema
 */
const runEventSchema = z.object({
  sequenceNumber: z.number(),
  eventType: z.string(),
  eventData: z.unknown(),
  createdAt: z.string(),
});

/**
 * Run result schema (present when status = 'completed')
 */
const runResultSchema = z.object({
  checkpointId: z.string(),
  agentSessionId: z.string(),
  conversationId: z.string(),
  artifact: z.record(z.string(), z.string()).optional(), // optional when run has no artifact
  volumes: z.record(z.string(), z.string()).optional(),
});

/**
 * Run state schema (replaces vm0_start/vm0_result/vm0_error events)
 */
const runStateSchema = z.object({
  status: runStatusSchema,
  result: runResultSchema.optional(),
  error: z.string().optional(),
});

/**
 * Events response schema
 */
const eventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  hasMore: z.boolean(),
  nextSequence: z.number(),
  run: runStateSchema,
  provider: z.string(),
});

/**
 * Runs main route contract (/api/agent/runs)
 * Handles POST create
 */
export const runsMainContract = c.router({
  /**
   * POST /api/agent/runs
   * Create and execute a new agent run
   */
  create: {
    method: "POST",
    path: "/api/agent/runs",
    body: unifiedRunRequestSchema,
    responses: {
      201: createRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create and execute agent run",
  },
});

/**
 * Runs by ID route contract (/api/agent/runs/[id])
 */
export const runsByIdContract = c.router({
  /**
   * GET /api/agent/runs/:id
   * Get agent run status and results
   */
  getById: {
    method: "GET",
    path: "/api/agent/runs/:id",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: getRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run by ID",
  },
});

/**
 * Run events route contract (/api/agent/runs/[id]/events)
 */
export const runEventsContract = c.router({
  /**
   * GET /api/agent/runs/:id/events
   * Poll for agent run events with pagination
   */
  getEvents: {
    method: "GET",
    path: "/api/agent/runs/:id/events",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().default(0),
      limit: z.coerce.number().default(100),
    }),
    responses: {
      200: eventsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run events",
  },
});

/**
 * Telemetry metric schema
 */
const telemetryMetricSchema = z.object({
  ts: z.string(),
  cpu: z.number(),
  mem_used: z.number(),
  mem_total: z.number(),
  disk_used: z.number(),
  disk_total: z.number(),
});

/**
 * System log response schema
 */
const systemLogResponseSchema = z.object({
  systemLog: z.string(),
  hasMore: z.boolean(),
});

/**
 * Metrics response schema
 */
const metricsResponseSchema = z.object({
  metrics: z.array(telemetryMetricSchema),
  hasMore: z.boolean(),
});

/**
 * Agent events response schema (for logs command)
 */
const agentEventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  hasMore: z.boolean(),
  provider: z.string(),
});

/**
 * Network log entry schema
 *
 * Supports two modes:
 * - sni: SNI-only mode (no HTTPS decryption, only host/port/action)
 * - mitm: MITM mode (full HTTP details including method, status, latency, sizes)
 */
const networkLogEntrySchema = z.object({
  timestamp: z.string(),
  // Common fields (all modes)
  mode: z.enum(["mitm", "sni"]).optional(),
  action: z.enum(["ALLOW", "DENY"]).optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  rule_matched: z.string().nullable().optional(),
  // MITM-only fields (optional)
  method: z.string().optional(),
  url: z.string().optional(),
  status: z.number().optional(),
  latency_ms: z.number().optional(),
  request_size: z.number().optional(),
  response_size: z.number().optional(),
});

/**
 * Network logs response schema
 */
const networkLogsResponseSchema = z.object({
  networkLogs: z.array(networkLogEntrySchema),
  hasMore: z.boolean(),
});

/**
 * Telemetry response schema (legacy - combined format)
 */
const telemetryResponseSchema = z.object({
  systemLog: z.string(),
  metrics: z.array(telemetryMetricSchema),
});

/**
 * Run telemetry route contract (/api/agent/runs/[id]/telemetry)
 * Legacy combined format
 */
export const runTelemetryContract = c.router({
  /**
   * GET /api/agent/runs/:id/telemetry
   * Get aggregated telemetry data for a run (legacy combined format)
   */
  getTelemetry: {
    method: "GET",
    path: "/api/agent/runs/:id/telemetry",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: telemetryResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get run telemetry data",
  },
});

/**
 * System log route contract (/api/agent/runs/[id]/telemetry/system-log)
 */
export const runSystemLogContract = c.router({
  /**
   * GET /api/agent/runs/:id/telemetry/system-log
   * Get system log with pagination
   */
  getSystemLog: {
    method: "GET",
    path: "/api/agent/runs/:id/telemetry/system-log",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(100).default(5),
      order: z.enum(["asc", "desc"]).default("desc"),
    }),
    responses: {
      200: systemLogResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get system log with pagination",
  },
});

/**
 * Metrics route contract (/api/agent/runs/[id]/telemetry/metrics)
 */
export const runMetricsContract = c.router({
  /**
   * GET /api/agent/runs/:id/telemetry/metrics
   * Get metrics with pagination
   */
  getMetrics: {
    method: "GET",
    path: "/api/agent/runs/:id/telemetry/metrics",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(100).default(5),
      order: z.enum(["asc", "desc"]).default("desc"),
    }),
    responses: {
      200: metricsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get metrics with pagination",
  },
});

/**
 * Agent events route contract (/api/agent/runs/[id]/telemetry/agent)
 */
export const runAgentEventsContract = c.router({
  /**
   * GET /api/agent/runs/:id/telemetry/agent
   * Get agent events with pagination (for vm0 logs default)
   */
  getAgentEvents: {
    method: "GET",
    path: "/api/agent/runs/:id/telemetry/agent",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(100).default(5),
      order: z.enum(["asc", "desc"]).default("desc"),
    }),
    responses: {
      200: agentEventsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent events with pagination",
  },
});

/**
 * Network logs route contract (/api/agent/runs/[id]/telemetry/network)
 */
export const runNetworkLogsContract = c.router({
  /**
   * GET /api/agent/runs/:id/telemetry/network
   * Get network logs with pagination (for vm0 logs --network)
   */
  getNetworkLogs: {
    method: "GET",
    path: "/api/agent/runs/:id/telemetry/network",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(100).default(5),
      order: z.enum(["asc", "desc"]).default("desc"),
    }),
    responses: {
      200: networkLogsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get network logs with pagination",
  },
});

export type RunsMainContract = typeof runsMainContract;
export type RunsByIdContract = typeof runsByIdContract;
export type RunEventsContract = typeof runEventsContract;
export type RunTelemetryContract = typeof runTelemetryContract;
export type RunSystemLogContract = typeof runSystemLogContract;
export type RunMetricsContract = typeof runMetricsContract;
export type RunAgentEventsContract = typeof runAgentEventsContract;
export type RunNetworkLogsContract = typeof runNetworkLogsContract;

// Export schemas for reuse
export {
  runStatusSchema,
  unifiedRunRequestSchema,
  createRunResponseSchema,
  getRunResponseSchema,
  runEventSchema,
  runResultSchema,
  runStateSchema,
  eventsResponseSchema,
  telemetryMetricSchema,
  telemetryResponseSchema,
  systemLogResponseSchema,
  metricsResponseSchema,
  agentEventsResponseSchema,
  networkLogEntrySchema,
  networkLogsResponseSchema,
};
