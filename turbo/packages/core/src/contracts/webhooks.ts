import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { networkLogEntrySchema } from "./runs";
import {
  storageTypeSchema,
  fileEntryWithHashSchema,
  storageChangesSchema,
  presignedUploadSchema,
} from "./storages";

const c = initContract();

/**
 * Sandbox reuse outcome. One enum value per code branch in the runner's
 * reuse-decision block. `reused` means the sandbox was unparked from the idle
 * pool; the remaining variants describe why reuse did not happen.
 */
export const sandboxReuseResultSchema = z.enum([
  "reused",
  "featureDisabled",
  "noSessionId",
  "poolMiss",
  "profileMismatch",
  "unparkFailed",
]);

export type SandboxReuseResult = z.infer<typeof sandboxReuseResultSchema>;

/**
 * Agent event schema for webhook events
 * Note: Claude Code JSONL events have varying structures with different fields
 * depending on the event type (system, assistant, user, result, etc.)
 * We require `type` and `sequenceNumber`, and allow any other fields to pass through
 */
const agentEventSchema = z
  .object({
    type: z.string(),
    sequenceNumber: z.number().int().nonnegative(),
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
 * Memory snapshot schema
 */
const memorySnapshotSchema = z.object({
  memoryName: z.string(),
  memoryVersion: z.string(),
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
   * Receive agent events from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/events",
    headers: authHeadersSchema,
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
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      exitCode: z.number(),
      error: z.string().optional(),
      // Sandbox id the run executed against. Optional because a run that fails
      // before VM creation has no sandbox. Persisted to agent_runs.sandbox_id;
      // the 255-char cap matches the DB column (defense in depth).
      sandboxId: z.string().max(255).optional(),
      // Sandbox reuse outcome. One enum value covers both "reused" and the
      // non-reuse reasons, because (reused, reason) is a partial function —
      // encoding it as one field makes inconsistent states unrepresentable.
      // Optional/nullable for old runners and historical rows.
      sandboxReuseResult: sandboxReuseResultSchema.optional(),
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
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      cliAgentType: z.string().min(1, "cliAgentType is required"),
      cliAgentSessionId: z.string().min(1, "cliAgentSessionId is required"),
      cliAgentSessionHistoryHash: z
        .string()
        .length(
          64,
          "cliAgentSessionHistoryHash must be a 64-character SHA-256 hex string",
        ),
      // Legacy singleton artifact snapshot. The guest-agent still emits this
      // when exactly one artifact is snapshotted so older servers can read it;
      // new code must read artifactSnapshots instead.
      artifactSnapshot: artifactSnapshotSchema.optional(),
      // Multi-artifact snapshot map: artifact name → version id. Emitted
      // unconditionally by the guest-agent (empty object when nothing to
      // snapshot). Double-written to both the legacy single-entry column and
      // the new artifact_snapshots JSONB column on checkpoints.
      artifactSnapshots: z.record(z.string(), z.string()).optional(),
      memorySnapshot: memorySnapshotSchema.optional(),
      volumeVersionsSnapshot: volumeVersionsSnapshotSchema.optional(),
    }),
    responses: {
      200: z.object({
        checkpointId: z.string(),
        agentSessionId: z.string(),
        conversationId: z.string(),
        artifact: artifactSnapshotSchema.optional(),
        artifacts: z.record(z.string(), z.string()).optional(),
        memory: memorySnapshotSchema.optional(),
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
 * Webhook checkpoint prepare-history contract for /api/webhooks/agent/checkpoints/prepare-history
 * Returns a presigned URL for uploading session history directly to S3,
 * bypassing Vercel's 4.5MB body size limit.
 */
export const webhookCheckpointsPrepareHistoryContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints/prepare-history",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      hash: z
        .string()
        .length(64, "hash must be a 64-character SHA-256 hex string"),
      size: z.number().int().positive("size must be a positive integer"),
    }),
    responses: {
      200: z.object({
        presignedUrl: z.string().optional(),
        existing: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get presigned URL for uploading session history to S3",
  },
});

/**
 * Webhook heartbeat contract for /api/webhooks/agent/heartbeat
 */
export const webhookHeartbeatContract = c.router({
  /**
   * POST /api/webhooks/agent/heartbeat
   * Receive heartbeat signals from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/heartbeat",
    headers: authHeadersSchema,
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
    headers: authHeadersSchema,
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
    headers: authHeadersSchema,
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
 * Sandbox operation schema for internal sandbox operations (init, storage, cli, checkpoint, cleanup)
 */
const sandboxOperationSchema = z.object({
  ts: z.string(),
  action_type: z.string(),
  duration_ms: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
});

/**
 * Webhook telemetry contract for /api/webhooks/agent/telemetry
 */
export const webhookTelemetryContract = c.router({
  /**
   * POST /api/webhooks/agent/telemetry
   * Receive telemetry data (system log, metrics, network logs, and sandbox operations) from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/telemetry",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      systemLog: z.string().optional(),
      metrics: z.array(metricDataSchema).optional(),
      networkLogs: z.array(networkLogEntrySchema).optional(),
      sandboxOperations: z.array(sandboxOperationSchema).optional(),
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

// ============================================================================
// Direct Upload Contracts (Webhook endpoints for sandbox)
// ============================================================================

/**
 * Webhook storage prepare contract for /api/webhooks/agent/storages/prepare
 *
 * Sandbox version of storage prepare endpoint.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 */
export const webhookStoragesPrepareContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/webhooks/agent/storages/prepare",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"), // Required for webhook auth
      storageName: z.string().min(1, "Storage name is required"),
      storageType: storageTypeSchema,
      files: z.array(fileEntryWithHashSchema),
      parentVersionId: z.string().optional(),
      force: z.boolean().optional(),
      baseVersion: z.string().optional(),
      changes: storageChangesSchema.optional(),
    }),
    responses: {
      200: z.object({
        versionId: z.string(),
        existing: z.boolean(),
        uploads: z
          .object({
            archive: presignedUploadSchema,
            manifest: presignedUploadSchema,
          })
          .optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare for direct S3 upload from sandbox",
  },
});

/**
 * Webhook storage commit contract for /api/webhooks/agent/storages/commit
 *
 * Sandbox version of storage commit endpoint.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 */
export const webhookStoragesCommitContract = c.router({
  commit: {
    method: "POST",
    path: "/api/webhooks/agent/storages/commit",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"), // Required for webhook auth
      storageName: z.string().min(1, "Storage name is required"),
      storageType: storageTypeSchema,
      versionId: z.string().min(1, "Version ID is required"),
      parentVersionId: z.string().optional(),
      files: z.array(fileEntryWithHashSchema),
      message: z.string().optional(),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        versionId: z.string(),
        storageName: z.string(),
        size: z.number(),
        fileCount: z.number(),
        deduplicated: z.boolean().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema, // S3 files missing
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Commit uploaded storage from sandbox",
  },
});

/**
 * Webhook usage contract for /api/webhooks/agent/usage
 *
 * Receives proxy-extracted LLM API usage data from the mitmproxy addon
 * for billing verification against client-reported usage.
 */
export const webhookUsageContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/usage",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      usage: z
        .object({
          model: z.string().optional(),
          message_id: z.string().optional(),
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
          cache_creation_input_tokens: z.number().optional(),
          web_search_requests: z.number().optional(),
        })
        .strict(),
    }),
    responses: {
      200: z.object({
        success: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive proxy-extracted usage data from sandbox",
  },
});

export type WebhookEventsContract = typeof webhookEventsContract;
export type WebhookCompleteContract = typeof webhookCompleteContract;
export type WebhookCheckpointsContract = typeof webhookCheckpointsContract;
export type WebhookCheckpointsPrepareHistoryContract =
  typeof webhookCheckpointsPrepareHistoryContract;
export type WebhookHeartbeatContract = typeof webhookHeartbeatContract;
export type WebhookStoragesContract = typeof webhookStoragesContract;
export type WebhookStoragesIncrementalContract =
  typeof webhookStoragesIncrementalContract;
export type WebhookTelemetryContract = typeof webhookTelemetryContract;
export type WebhookStoragesPrepareContract =
  typeof webhookStoragesPrepareContract;
export type WebhookStoragesCommitContract =
  typeof webhookStoragesCommitContract;
export type WebhookUsageContract = typeof webhookUsageContract;

/**
 * Webhook connector billing contract for /api/webhooks/agent/connector-billing
 *
 * Receives per-API-call connector billing records (billable resource counts)
 * from the mitmproxy addon for billing attribution.
 */
export const webhookConnectorBillingContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/connector-billing",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().min(1, "runId is required"),
      flowId: z.string().min(1).max(100),
      connector: z.string().min(1).max(50),
      category: z.string().min(1).max(100),
      quantity: z.number().int().min(0),
    }),
    responses: {
      200: z.object({
        success: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive connector billing data from sandbox",
  },
});

export type WebhookConnectorBillingContract =
  typeof webhookConnectorBillingContract;
