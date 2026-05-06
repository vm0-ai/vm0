import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { firewallPoliciesSchema } from "@vm0/connectors/firewall-types";
import { triggerSourceSchema } from "./logs";
import { orgTierSchema } from "./orgs";

const c = initContract();

/**
 * All valid run status values
 */
export const ALL_RUN_STATUSES = [
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;

/**
 * Run status enum
 */
const runStatusSchema = z.enum(ALL_RUN_STATUSES);

/**
 * Unified run request schema - supports all run modes via optional parameters
 */
const unifiedRunRequestSchema = z
  .object({
    // High-level shortcuts (mutually exclusive with each other)
    checkpointId: z.string().optional(),
    sessionId: z.string().optional(),

    // Base parameters (can be used directly or overridden after shortcut expansion)
    agentComposeId: z.string().optional(),
    agentComposeVersionId: z.string().optional(),
    conversationId: z.string().optional(),
    // Multi-mount artifacts, each with its own mountPath.
    artifacts: z
      .array(
        z.object({
          name: z.string(),
          version: z.string().optional(),
          mountPath: z.string(),
        }),
      )
      .optional(),
    vars: z.record(z.string(), z.string()).optional(),
    secrets: z.record(z.string(), z.string()).optional(),
    volumeVersions: z.record(z.string(), z.string()).optional(),

    // Additional volumes passed directly at run time (bypass compose)
    additionalVolumes: z
      .array(
        z.object({
          name: z.string(),
          version: z.string().optional(),
          mountPath: z.string(),
        }),
      )
      .optional(),

    // Debug flag to force real Claude in mock environments (internal use only)
    debugNoMockClaude: z.boolean().optional(),

    // Debug flag to force real Codex in mock environments (internal use only)
    debugNoMockCodex: z.boolean().optional(),

    // Capture HTTP request headers, request bodies, and response bodies in network logs
    captureNetworkBodies: z.boolean().optional(),

    // Required
    prompt: z.string().min(1, "Missing prompt"),

    // Optional system prompt to append to the agent's system prompt
    appendSystemPrompt: z.string().optional(),

    // Optional list of tools to disable in Claude CLI (passed as --disallowed-tools)
    disallowedTools: z.array(z.string()).optional(),

    // Optional list of tools to make available in Claude CLI (passed as --tools)
    tools: z.array(z.string()).optional(),

    // Settings JSON to pass to Claude CLI (passed as --settings)
    settings: z.string().optional(),

    // How the run was triggered (defaults to "cli" on the server if not provided)
    triggerSource: triggerSourceSchema.optional(),

    // Per-permission policies (e.g., { "github": { "actions:read": "allow" } })
    permissionPolicies: firewallPoliciesSchema.optional(),
  })
  .strict();

/**
 * Create run response schema
 */
const createRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  sandboxId: z.string().optional(),
  // Agent session id — eagerly created at run insertion, always present.
  sessionId: z.string().uuid(),
  output: z.string().optional(),
  error: z.string().optional(),
  executionTimeMs: z.number().optional(),
  createdAt: z.string().optional(),
});

/**
 * Get run response schema
 */
const getRunResponseSchema = z.object({
  runId: z.string(),
  agentComposeVersionId: z.string().nullable(),
  status: runStatusSchema,
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  vars: z.record(z.string(), z.string()).optional(),
  sandboxId: z.string().optional(),
  result: z
    .object({
      output: z.string().optional(),
      executionTimeMs: z.number().optional(),
      agentSessionId: z.string().optional(),
      checkpointId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .passthrough()
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
  framework: z.string(),
});

/**
 * Run list item schema
 */
const runListItemSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  status: runStatusSchema,
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
});

/**
 * Runs list response schema
 */
const runsListResponseSchema = z.object({
  runs: z.array(runListItemSchema),
});

/**
 * Runs main route contract (/api/agent/runs)
 * Handles GET list and POST create
 */
export const runsMainContract = c.router({
  /**
   * GET /api/agent/runs
   * List agent runs (pending and running by default)
   */
  list: {
    method: "GET",
    path: "/api/agent/runs",
    headers: authHeadersSchema,
    query: z.object({
      status: z.string().optional(), // comma-separated: "pending,running"
      agent: z.string().optional(), // agent name filter
      since: z.string().optional(), // ISO timestamp
      until: z.string().optional(), // ISO timestamp
      limit: z.coerce.number().min(1).max(100).default(50),
    }),
    responses: {
      200: runsListResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List agent runs",
  },
  /**
   * POST /api/agent/runs
   * Create and execute a new agent run
   */
  create: {
    method: "POST",
    path: "/api/agent/runs",
    headers: authHeadersSchema,
    body: unifiedRunRequestSchema,
    responses: {
      201: createRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      422: apiErrorSchema,
      503: apiErrorSchema,
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
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
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
 * Cancel run response schema
 */
const cancelRunResponseSchema = z.object({
  id: z.string(),
  status: z.literal("cancelled"),
  message: z.string(),
});

/**
 * Runs cancel route contract (/api/agent/runs/[id]/cancel)
 */
export const runsCancelContract = c.router({
  /**
   * POST /api/agent/runs/:id/cancel
   * Cancel a pending or running run
   */
  cancel: {
    method: "POST",
    path: "/api/agent/runs/:id/cancel",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    body: z.undefined(),
    responses: {
      200: cancelRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Cancel a pending or running run",
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
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    query: z.object({
      since: z.coerce.number().default(-1),
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
  framework: z.string(),
});

/**
 * Network log entry schema.
 * [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
 */
const networkLogEntrySchema = z.object({
  timestamp: z.string(),
  type: z.string().optional(),
  action: z.enum(["ALLOW", "DENY"]).optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  method: z.string().optional(),
  url: z.string().optional(),
  status: z.number().optional(),
  latency_ms: z.number().optional(),
  request_size: z.number().optional(),
  response_size: z.number().optional(),
  dns_event: z.string().optional(),
  dns_query_type: z.string().optional(),
  dns_result: z.string().optional(),
  dns_serial: z.string().optional(),
  firewall_base: z.string().optional(),
  firewall_name: z.string().optional(),
  firewall_permission: z.string().optional(),
  firewall_rule_match: z.string().optional(),
  firewall_params: z.record(z.string(), z.string()).optional(),
  firewall_billable: z.boolean().optional(),
  firewall_error: z.string().optional(),
  auth_resolved_secrets: z.array(z.string()).optional(),
  auth_refreshed_connectors: z.array(z.string()).optional(),
  auth_refreshed_secrets: z.array(z.string()).optional(),
  auth_cache_hit: z.boolean().optional(),
  auth_url_rewrite: z.boolean().optional(),
  error: z.string().optional(),
  // Capture-only fields (opt-in via captureNetworkBodies)
  request_headers: z.record(z.string(), z.string()).optional(),
  request_body: z.string().optional(),
  request_body_encoding: z.enum(["utf-8", "base64", "binary"]).optional(),
  request_body_truncated: z.boolean().optional(),
  response_headers: z.record(z.string(), z.string()).optional(),
  response_body: z.string().optional(),
  response_body_encoding: z.enum(["utf-8", "base64", "binary"]).optional(),
  response_body_truncated: z.boolean().optional(),
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
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
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
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
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
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
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
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
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
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
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
export type RunsCancelContract = typeof runsCancelContract;
export type RunEventsContract = typeof runEventsContract;
export type RunTelemetryContract = typeof runTelemetryContract;
export type RunSystemLogContract = typeof runSystemLogContract;
export type RunMetricsContract = typeof runMetricsContract;
export type RunAgentEventsContract = typeof runAgentEventsContract;
export type RunNetworkLogsContract = typeof runNetworkLogsContract;

/**
 * Logs search result schema
 */
const searchResultSchema = z.object({
  runId: z.string(),
  agentName: z.string(),
  matchedEvent: runEventSchema,
  contextBefore: z.array(runEventSchema),
  contextAfter: z.array(runEventSchema),
});

/**
 * Logs search response schema
 */
const logsSearchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  hasMore: z.boolean(),
});

/**
 * Logs search route contract (/api/logs/search)
 * Search agent events across runs
 */
export const logsSearchContract = c.router({
  /**
   * GET /api/logs/search
   * Search agent events across runs using keyword matching
   */
  searchLogs: {
    method: "GET",
    path: "/api/logs/search",
    headers: authHeadersSchema,
    query: z.object({
      keyword: z.string().min(1),
      agentId: z.string().uuid().optional(),
      runId: z.string().optional(),
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(50).default(20),
      before: z.coerce.number().min(0).max(10).default(0),
      after: z.coerce.number().min(0).max(10).default(0),
    }),
    responses: {
      200: logsSearchResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Search agent events across runs",
  },
});

export type LogsSearchContract = typeof logsSearchContract;

/**
 * Queue entry schema — own entries have real data, others have null for private fields
 * Ownership is detected via runId: non-null = own entry, null = other user's entry
 */
const queueEntrySchema = z.object({
  position: z.number(),
  agentName: z.string().nullable(),
  agentDisplayName: z.string().nullable(),
  userEmail: z.string().nullable(),
  createdAt: z.string(),
  isOwner: z.boolean(),
  runId: z.string().nullable(),
  prompt: z.string().nullable(),
  triggerSource: triggerSourceSchema.nullable(),
  sessionLink: z.string().nullable(),
});

/**
 * Running task schema — shows currently executing runs
 */
const runningTaskSchema = z.object({
  runId: z.string().nullable(),
  agentName: z.string(),
  agentDisplayName: z.string().nullable(),
  userEmail: z.string(),
  startedAt: z.string().nullable(),
  isOwner: z.boolean(),
});

/**
 * Concurrency info schema
 */
const concurrencyInfoSchema = z.object({
  tier: orgTierSchema,
  limit: z.number(),
  active: z.number(),
  available: z.number(),
});

/**
 * Queue response schema
 */
const queueResponseSchema = z.object({
  concurrency: concurrencyInfoSchema,
  queue: z.array(queueEntrySchema),
  runningTasks: z.array(runningTaskSchema),
  estimatedTimePerRun: z.number().nullable(),
});

/**
 * Runs queue route contract (/api/agent/runs/queue)
 * Returns org-wide queue status with concurrency context
 */
export const runsQueueContract = c.router({
  /**
   * GET /api/agent/runs/queue
   * Get org run queue status including concurrency context and queued entries
   */
  getQueue: {
    method: "GET",
    path: "/api/agent/runs/queue",
    headers: authHeadersSchema,
    responses: {
      200: queueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get org run queue status",
  },
});

export type RunsQueueContract = typeof runsQueueContract;

// Export schemas for reuse
export {
  runStatusSchema,
  unifiedRunRequestSchema,
  createRunResponseSchema,
  getRunResponseSchema,
  runListItemSchema,
  runsListResponseSchema,
  cancelRunResponseSchema,
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
  searchResultSchema,
  logsSearchResponseSchema,
  queueEntrySchema,
  runningTaskSchema,
  concurrencyInfoSchema,
  queueResponseSchema,
};

// Export inferred types for consumers
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;
export type GetRunResponse = z.infer<typeof getRunResponseSchema>;
export type RunListItem = z.infer<typeof runListItemSchema>;
export type RunsListResponse = z.infer<typeof runsListResponseSchema>;
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;
export type EventsResponse = z.infer<typeof eventsResponseSchema>;
export type TelemetryMetric = z.infer<typeof telemetryMetricSchema>;
export type TelemetryResponse = z.infer<typeof telemetryResponseSchema>;
export type SystemLogResponse = z.infer<typeof systemLogResponseSchema>;
export type MetricsResponse = z.infer<typeof metricsResponseSchema>;
export type AgentEventsResponse = z.infer<typeof agentEventsResponseSchema>;
export type NetworkLogEntry = z.infer<typeof networkLogEntrySchema>;
export type NetworkLogsResponse = z.infer<typeof networkLogsResponseSchema>;
/**
 * Axiom raw network event — the shape returned by `queryAxiom` for network logs.
 * Uses `_time` (Axiom's timestamp field) instead of `timestamp`, and includes
 * `runId`/`userId` used for Axiom filtering.
 */
export type AxiomNetworkEvent = Omit<NetworkLogEntry, "timestamp"> & {
  _time: string;
  runId: string;
  userId: string;
};
export type SearchResult = z.infer<typeof searchResultSchema>;
export type LogsSearchResponse = z.infer<typeof logsSearchResponseSchema>;
export type QueueEntry = z.infer<typeof queueEntrySchema>;
export type RunningTask = z.infer<typeof runningTaskSchema>;
export type ConcurrencyInfo = z.infer<typeof concurrencyInfoSchema>;
export type QueueResponse = z.infer<typeof queueResponseSchema>;
