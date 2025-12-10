import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Agent event schema for webhook events
 * Note: Claude Code JSONL events have varying structures with different fields
 * depending on the event type (system, assistant, user, result, etc.)
 * We only require `type` and allow any other fields to pass through
 */
const agentEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

/**
 * Artifact snapshot schema
 */
const artifactSnapshotSchema = z.object({
  artifactName: z.string(),
  artifactVersion: z.string(),
});

/**
 * Volume versions snapshot schema
 */
const volumeVersionsSnapshotSchema = z.object({
  versions: z.record(z.string(), z.string()),
});

/**
 * Webhook events contract for /api/webhooks/agent/events
 */
export const webhookEventsContract = c.router({
  /**
   * POST /api/webhooks/agent/events
   * Receive agent events from E2B sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/events",
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      events: z.array(agentEventSchema).min(1, "events array cannot be empty"),
    }),
    responses: {
      200: z.object({
        received: z.number(),
        firstSequence: z.number(),
        lastSequence: z.number(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive agent events from sandbox",
  },
});

/**
 * Webhook complete contract for /api/webhooks/agent/complete
 */
export const webhookCompleteContract = c.router({
  /**
   * POST /api/webhooks/agent/complete
   * Handle agent run completion (success or failure)
   */
  complete: {
    method: "POST",
    path: "/api/webhooks/agent/complete",
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      exitCode: z.number(),
      error: z.string().optional(),
    }),
    responses: {
      200: z.object({
        success: z.boolean(),
        status: z.enum(["completed", "failed"]),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Handle agent run completion",
  },
});

/**
 * Webhook checkpoints contract for /api/webhooks/agent/checkpoints
 */
export const webhookCheckpointsContract = c.router({
  /**
   * POST /api/webhooks/agent/checkpoints
   * Create checkpoint for completed agent run
   */
  create: {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints",
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      cliAgentType: z.string().min(1, "cliAgentType is required"),
      cliAgentSessionId: z.string().min(1, "cliAgentSessionId is required"),
      cliAgentSessionHistory: z
        .string()
        .min(1, "cliAgentSessionHistory is required"),
      artifactSnapshot: artifactSnapshotSchema,
      volumeVersionsSnapshot: volumeVersionsSnapshotSchema.optional(),
    }),
    responses: {
      200: z.object({
        checkpointId: z.string(),
        agentSessionId: z.string(),
        conversationId: z.string(),
        artifact: artifactSnapshotSchema,
        volumes: z.record(z.string(), z.string()).optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create checkpoint for agent run",
  },
});

/**
 * Webhook heartbeat contract for /api/webhooks/agent/heartbeat
 */
export const webhookHeartbeatContract = c.router({
  /**
   * POST /api/webhooks/agent/heartbeat
   * Receive heartbeat signals from E2B sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/heartbeat",
    body: z.object({
      runId: z.string().min(1, "runId is required"),
    }),
    responses: {
      200: z.object({
        ok: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive heartbeat from sandbox",
  },
});

/**
 * Webhook storages contract for /api/webhooks/agent/storages
 * Note: This endpoint handles multipart form data upload
 * The contract defines the JSON response schema
 */
export const webhookStoragesContract = c.router({
  /**
   * POST /api/webhooks/agent/storages
   * Create a new version of a storage from sandbox
   *
   * Form fields:
   * - runId: string (required)
   * - storageName: string (required)
   * - message: string (optional)
   * - file: File (required, tar.gz archive)
   */
  upload: {
    method: "POST",
    path: "/api/webhooks/agent/storages",
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: z.object({
        versionId: z.string(),
        storageName: z.string(),
        size: z.number(),
        fileCount: z.number(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Upload storage version from sandbox",
  },
});

/**
 * Webhook storages incremental contract for /api/webhooks/agent/storages/incremental
 * Note: This endpoint handles multipart form data upload
 */
export const webhookStoragesIncrementalContract = c.router({
  /**
   * POST /api/webhooks/agent/storages/incremental
   * Create a new version using incremental upload
   *
   * Form fields:
   * - runId: string (required)
   * - storageName: string (required)
   * - baseVersion: string (required)
   * - changes: JSON string (required)
   * - message: string (optional)
   * - file: File (optional, tar.gz of changed files)
   */
  upload: {
    method: "POST",
    path: "/api/webhooks/agent/storages/incremental",
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: z.object({
        versionId: z.string(),
        storageName: z.string(),
        size: z.number(),
        fileCount: z.number(),
        incrementalStats: z
          .object({
            addedFiles: z.number(),
            modifiedFiles: z.number(),
            deletedFiles: z.number(),
            unchangedFiles: z.number(),
            bytesUploaded: z.number(),
          })
          .optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Upload storage version incrementally from sandbox",
  },
});

/**
 * Metric data point schema
 */
const metricDataSchema = z.object({
  ts: z.string(),
  cpu: z.number(),
  mem_used: z.number(),
  mem_total: z.number(),
  disk_used: z.number(),
  disk_total: z.number(),
});

/**
 * Webhook telemetry contract for /api/webhooks/agent/telemetry
 */
export const webhookTelemetryContract = c.router({
  /**
   * POST /api/webhooks/agent/telemetry
   * Receive telemetry data (system log and metrics) from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/telemetry",
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      systemLog: z.string().optional(),
      metrics: z.array(metricDataSchema).optional(),
    }),
    responses: {
      200: z.object({
        success: z.boolean(),
        id: z.string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive telemetry data from sandbox",
  },
});

export type WebhookEventsContract = typeof webhookEventsContract;
export type WebhookCompleteContract = typeof webhookCompleteContract;
export type WebhookCheckpointsContract = typeof webhookCheckpointsContract;
export type WebhookHeartbeatContract = typeof webhookHeartbeatContract;
export type WebhookStoragesContract = typeof webhookStoragesContract;
export type WebhookStoragesIncrementalContract =
  typeof webhookStoragesIncrementalContract;
export type WebhookTelemetryContract = typeof webhookTelemetryContract;
