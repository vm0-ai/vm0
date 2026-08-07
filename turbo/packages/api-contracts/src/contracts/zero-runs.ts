import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  executionFirewallBuiltinEntrySchema,
  networkPoliciesSchema,
} from "@vm0/connectors/firewall-types";
import {
  getRunResponseSchema,
  cancelRunResponseSchema,
  agentEventsResponseSchema,
  queueResponseSchema,
  unifiedRunRequestSchema,
  networkLogsResponseSchema,
  systemLogResponseSchema,
  metricsResponseSchema,
  logsSearchQuerySchema,
  logsSearchResponseSchema,
  createLogPaginationQuerySchema,
} from "./runs";
import { sandboxReuseResultSchema } from "./webhooks";

/**
 * Zero run request schema — subset of unified schema.
 * Server-side defaults are injected by createZeroRun():
 * artifacts, disallowedTools.
 * Fields not used by unattended workflow runs are omitted:
 * triggerSource, vars, secrets, volumeVersions, permissionPolicies.
 */
export const zeroRunCreateBodySchema = unifiedRunRequestSchema
  .omit({
    triggerSource: true,
    artifacts: true,
    disallowedTools: true,
    volumeVersions: true,
    vars: true,
    secrets: true,
    agentComposeId: true,
    appendSystemPrompt: true,
    modelProviderType: true,
    permissionPolicies: true,
  })
  .extend({
    agentId: z.string().optional(),
    modelProvider: z.string().optional(),
  });

const c = initContract();

const zeroLogPaginationQuerySchema = createLogPaginationQuerySchema({
  cursorKind: "sequence",
});

const zeroNetworkLogPaginationQuerySchema = createLogPaginationQuerySchema({
  cursorKind: "time",
  maxLimit: 500,
  defaultLimit: 500,
  defaultOrder: "asc",
});

const zeroTelemetryTimePaginationQuerySchema = createLogPaginationQuerySchema({
  cursorKind: "time",
});

/**
 * Zero runs by ID contract (GET /api/zero/runs/:id)
 */
export const zeroRunsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/zero/runs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    responses: {
      200: getRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run by ID (zero proxy)",
  },
});

/**
 * Zero runs cancel contract (POST /api/zero/runs/:id/cancel)
 */
export const zeroRunsCancelContract = c.router({
  cancel: {
    method: "POST",
    path: "/api/zero/runs/:id/cancel",
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
    summary: "Cancel a pending or running run (zero proxy)",
  },
});

/**
 * Zero runs queue contract (GET /api/zero/runs/queue)
 */
export const zeroRunsQueueContract = c.router({
  getQueue: {
    method: "GET",
    path: "/api/zero/runs/queue",
    headers: authHeadersSchema,
    responses: {
      200: queueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get org run queue status (zero proxy)",
  },
});

/**
 * Zero run agent events contract (GET /api/zero/runs/:id/telemetry/agent)
 * Zero-namespaced agent events read (same response shape as the retired /api/agent telemetry route)
 */
export const zeroRunAgentEventsContract = c.router({
  getAgentEvents: {
    method: "GET",
    path: "/api/zero/runs/:id/telemetry/agent",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    query: zeroLogPaginationQuerySchema,
    responses: {
      200: agentEventsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent events with pagination (zero proxy)",
  },
});

/**
 * Zero run system log contract (GET /api/zero/runs/:id/telemetry/system-log)
 */
export const zeroRunSystemLogContract = c.router({
  getSystemLog: {
    method: "GET",
    path: "/api/zero/runs/:id/telemetry/system-log",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    query: zeroTelemetryTimePaginationQuerySchema,
    responses: {
      200: systemLogResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get system log with pagination",
  },
});

/**
 * Zero run metrics contract (GET /api/zero/runs/:id/telemetry/metrics)
 */
export const zeroRunMetricsContract = c.router({
  getMetrics: {
    method: "GET",
    path: "/api/zero/runs/:id/telemetry/metrics",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    query: zeroTelemetryTimePaginationQuerySchema,
    responses: {
      200: metricsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get metrics with pagination",
  },
});

/**
 * Run context snapshot — sanitized execution context for debugging.
 * Dynamic fields (environment, firewalls, volumes, artifact) are stored in Axiom.
 * Static fields (prompt, vars, secretNames) are merged from agent_runs at query time.
 */
const runContextVolumeSchema = z.object({
  name: z.string(),
  mountPath: z.string(),
  vasStorageName: z.string(),
  vasVersionId: z.string(),
});

const runContextArtifactSchema = z.object({
  mountPath: z.string(),
  vasStorageName: z.string(),
  vasVersionId: z.string(),
});

const runContextSanitizedFirewallSchema = z.object({
  name: z.string(),
  apis: z.array(
    z.object({
      base: z.string(),
      permissions: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            rules: z.array(z.string()),
          }),
        )
        .optional(),
    }),
  ),
});

const runContextFirewallSchema = z.union([
  executionFirewallBuiltinEntrySchema,
  runContextSanitizedFirewallSchema,
]);

export const runContextResponseSchema = z.object({
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  runId: z.string(),
  sessionId: z.string().nullable(),
  cliAgentType: z.string().optional(),
  secretNames: z.array(z.string()),
  vars: z.record(z.string(), z.string()).nullable(),
  environment: z.record(z.string(), z.string()),
  firewalls: z.array(runContextFirewallSchema),
  networkPolicies: networkPoliciesSchema.nullable(),
  volumes: z.array(runContextVolumeSchema),
  artifact: runContextArtifactSchema.nullable(),
  featureFlags: z.record(z.string(), z.boolean()).nullable(),
});

/**
 * Zero run context contract (GET /api/zero/runs/:id/context)
 * Returns sanitized execution context snapshot for debugging
 */
export const zeroRunContextContract = c.router({
  getContext: {
    method: "GET",
    path: "/api/zero/runs/:id/context",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    responses: {
      200: runContextResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get run execution context snapshot for debugging",
  },
});

/**
 * Zero run network logs contract (GET /api/zero/runs/:id/network)
 * Returns mitmproxy network logs for a run
 */
export const zeroRunNetworkLogsContract = c.router({
  getNetworkLogs: {
    method: "GET",
    path: "/api/zero/runs/:id/network",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    query: zeroNetworkLogPaginationQuerySchema,
    responses: {
      200: networkLogsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get network logs for a run",
  },
});

/**
 * Zero run runner contract (GET /api/zero/runs/:id/runner)
 * Returns runner-level metadata about how the run was provisioned
 * (sandbox reuse decision, etc.). Kept separate from logDetailSchema
 * so runner-tab fields can grow without polluting the generic log
 * detail response.
 */
const runRunnerResponseSchema = z.object({
  sandboxReuseResult: sandboxReuseResultSchema.nullable(),
});

export const zeroRunRunnerContract = c.router({
  getRunner: {
    method: "GET",
    path: "/api/zero/runs/:id/runner",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid("Run ID must be a valid UUID"),
    }),
    responses: {
      200: runRunnerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get runner-level metadata for a run",
  },
});

/**
 * Zero logs search contract (GET /api/zero/logs/search)
 * Search agent events across runs via zero token auth
 */
export const zeroLogsSearchContract = c.router({
  searchLogs: {
    method: "GET",
    path: "/api/zero/logs/search",
    headers: authHeadersSchema,
    query: logsSearchQuerySchema,
    responses: {
      200: logsSearchResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Search agent events across runs (zero proxy)",
  },
});

// Inferred types from Zod schemas
export type RunContextResponse = z.infer<typeof runContextResponseSchema>;
export type RunRunnerResponse = z.infer<typeof runRunnerResponseSchema>;

// Type exports
export type ZeroLogsSearchContract = typeof zeroLogsSearchContract;
export type ZeroRunsByIdContract = typeof zeroRunsByIdContract;
export type ZeroRunsCancelContract = typeof zeroRunsCancelContract;
export type ZeroRunsQueueContract = typeof zeroRunsQueueContract;
export type ZeroRunAgentEventsContract = typeof zeroRunAgentEventsContract;
export type ZeroRunSystemLogContract = typeof zeroRunSystemLogContract;
export type ZeroRunMetricsContract = typeof zeroRunMetricsContract;
export type ZeroRunContextContract = typeof zeroRunContextContract;
export type ZeroRunNetworkLogsContract = typeof zeroRunNetworkLogsContract;
export type ZeroRunRunnerContract = typeof zeroRunRunnerContract;
