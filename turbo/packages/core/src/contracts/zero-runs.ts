import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  createRunResponseSchema,
  getRunResponseSchema,
  cancelRunResponseSchema,
  agentEventsResponseSchema,
  queueResponseSchema,
  unifiedRunRequestSchema,
  networkLogsResponseSchema,
  logsSearchResponseSchema,
} from "./runs";

/**
 * Zero run request schema — subset of unified schema.
 * Server-side defaults are injected by createZeroRun():
 * memoryName, artifactName, disallowedTools.
 * Fields not used by zero triggers are omitted:
 * triggerSource, artifactVersion, vars, secrets, volumeVersions.
 */
const zeroRunRequestSchema = unifiedRunRequestSchema
  .omit({
    triggerSource: true,
    memoryName: true,
    artifactName: true,
    artifactVersion: true,
    disallowedTools: true,
    volumeVersions: true,
    vars: true,
    secrets: true,
    agentComposeId: true,
    appendSystemPrompt: true,
  })
  .extend({
    agentId: z.string().optional(),
    modelProvider: z.string().optional(),
  });

const c = initContract();

/**
 * Zero runs main contract (POST /api/zero/runs)
 * Proxies to runsMainContract.create
 */
export const zeroRunsMainContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/runs",
    headers: authHeadersSchema,
    body: zeroRunRequestSchema,
    responses: {
      201: createRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create and execute agent run (zero proxy)",
  },
});

/**
 * Zero runs by ID contract (GET /api/zero/runs/:id)
 * Proxies to runsByIdContract
 */
export const zeroRunsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/zero/runs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: getRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run by ID (zero proxy)",
  },
});

/**
 * Zero runs cancel contract (POST /api/zero/runs/:id/cancel)
 * Proxies to runsCancelContract
 */
export const zeroRunsCancelContract = c.router({
  cancel: {
    method: "POST",
    path: "/api/zero/runs/:id/cancel",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
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
 * Proxies to runsQueueContract
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
 * Proxies to runAgentEventsContract
 */
export const zeroRunAgentEventsContract = c.router({
  getAgentEvents: {
    method: "GET",
    path: "/api/zero/runs/:id/telemetry/agent",
    headers: authHeadersSchema,
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
    summary: "Get agent events with pagination (zero proxy)",
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

const runContextFirewallSchema = z.object({
  name: z.string(),
  ref: z.string(),
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

const runContextResponseSchema = z.object({
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  sessionId: z.string().nullable(),
  secretNames: z.array(z.string()),
  vars: z.record(z.string(), z.string()).nullable(),
  environment: z.record(z.string(), z.string()),
  firewalls: z.array(runContextFirewallSchema),
  volumes: z.array(runContextVolumeSchema),
  artifact: runContextArtifactSchema.nullable(),
  memory: runContextArtifactSchema.nullable(),
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
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: runContextResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
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
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(500).default(500),
      order: z.enum(["asc", "desc"]).default("asc"),
    }),
    responses: {
      200: networkLogsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get network logs for a run",
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
    query: z.object({
      keyword: z.string().min(1),
      agent: z.string().optional(),
      runId: z.string().optional(),
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(50).default(20),
      before: z.coerce.number().min(0).max(10).default(0),
      after: z.coerce.number().min(0).max(10).default(0),
    }),
    responses: {
      200: logsSearchResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Search agent events across runs (zero proxy)",
  },
});

// Inferred types from Zod schemas
export type RunContextResponse = z.infer<typeof runContextResponseSchema>;

// Type exports
export type ZeroLogsSearchContract = typeof zeroLogsSearchContract;
export type ZeroRunsMainContract = typeof zeroRunsMainContract;
export type ZeroRunsByIdContract = typeof zeroRunsByIdContract;
export type ZeroRunsCancelContract = typeof zeroRunsCancelContract;
export type ZeroRunsQueueContract = typeof zeroRunsQueueContract;
export type ZeroRunAgentEventsContract = typeof zeroRunAgentEventsContract;
export type ZeroRunContextContract = typeof zeroRunContextContract;
export type ZeroRunNetworkLogsContract = typeof zeroRunNetworkLogsContract;
