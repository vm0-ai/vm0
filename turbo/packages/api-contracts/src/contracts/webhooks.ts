import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { secretConnectorMetadataMapSchema } from "./runners";
import { eventSequenceNumberSchema, networkLogEntrySchema } from "./runs";
import {
  storageTypeSchema,
  fileEntryWithHashSchema,
  storageChangesSchema,
  presignedUploadSchema,
} from "./storages";

const c = initContract();

const thirdPartyWebhookErrorSchema = z.object({ error: z.string() });
const thirdPartyWebhookOkSchema = z.union([
  z.string(),
  z.object({ message: z.literal("pong") }),
]);

/**
 * Clerk third-party webhook contract for /api/webhooks/clerk.
 */
export const webhookClerkContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/clerk",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      401: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Clerk organization and user webhooks",
  },
});

/**
 * GitHub App third-party webhook contract for /api/webhooks/github.
 */
export const webhookGithubContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/github",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle GitHub App webhooks",
  },
});

/**
 * Stripe third-party webhook contract for /api/webhooks/stripe.
 */
export const webhookStripeContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/stripe",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Stripe billing webhooks",
  },
});

export const webhookBuiltInGenerationFalContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/built-in-generations/fal/:generationId",
    pathParams: z.object({
      generationId: z.uuid(),
    }),
    query: z.object({
      token: z.string().min(1),
      visualKey: z.string().min(1).optional(),
    }),
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle fal built-in generation webhooks",
  },
});

/**
 * Sandbox reuse outcome. One enum value per code branch in the runner's
 * reuse-decision block. `reused` means the sandbox was unparked from the idle
 * pool; the remaining variants describe why reuse did not happen.
 *
 * `featureDisabled` is legacy: written by older runners while reuse was gated
 * by the `sandboxReuse` feature flag (removed when reuse went to full rollout
 * in #10744). Retained here so historical `agent_runs.sandbox_reuse_result`
 * rows still parse on read. The runner no longer emits it.
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
    sequenceNumber: eventSequenceNumberSchema,
  })
  .passthrough();

/**
 * Artifact snapshots schema — canonical `Array<{name, version, mountPath}>`
 * form. Legacy `Record<name, version>` support was removed in #10913 after
 * the DB migration and guest-agent writer flip completed.
 */
const artifactSnapshotsSchema = z.array(
  z.object({
    name: z.string(),
    version: z.string(),
    mountPath: z.string(),
  }),
);

/**
 * Volume versions snapshot schema
 */
const volumeVersionsSnapshotSchema = z.object({
  versions: z.record(z.string(), z.string()),
});

const firewallAuthErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
    connectors: z.array(z.string()).optional(),
  }),
});

const firewallAuthResponseSchema = z.object({
  headers: z.record(z.string(), z.string()),
  base: z.string().optional(),
  query: z.record(z.string(), z.string()).optional(),
  // Effective addon cache expiry as Unix seconds. OAuth token expiry is the
  // normal source; billable firewall auth can shorten it to force credit
  // re-authorization. Null means non-expiring only for non-billable auth.
  expiresAt: z.number().nullable(),
  resolvedSecrets: z.array(z.string()),
  refreshedConnectors: z.array(z.string()),
  refreshedSecrets: z.array(z.string()),
});

export const webhookFirewallAuthContract = c.router({
  /**
   * POST /api/webhooks/agent/firewall/auth
   * Resolve firewall auth templates and refresh OAuth tokens on demand.
   */
  resolve: {
    method: "POST",
    path: "/api/webhooks/agent/firewall/auth",
    headers: authHeadersSchema,
    body: z.object({
      encryptedSecrets: z.string().min(1),
      authHeaders: z.record(z.string(), z.string()),
      authBase: z.string().optional(),
      authQuery: z.record(z.string(), z.string()).optional(),
      secretConnectorMap: z.record(z.string(), z.string()).optional(),
      secretConnectorMetadataMap: secretConnectorMetadataMapSchema.optional(),
      vars: z.record(z.string(), z.string()).optional(),
      // Set by mitm from billableFirewalls. Server uses this only to bound
      // auth cache lifetime by the current credit authorization lease.
      firewallBillable: z.boolean().optional(),
      forceRefresh: z.boolean().optional(),
    }),
    responses: {
      200: firewallAuthResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      424: firewallAuthErrorSchema,
      502: firewallAuthErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve firewall auth templates",
  },
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
      lastEventSequence: eventSequenceNumberSchema.optional(),
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
   * Create a recoverable checkpoint for an agent run.
   */
  create: {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints",
    headers: authHeadersSchema,
    body: z
      .object({
        runId: z.string().min(1, "runId is required"),
        cliAgentType: z.string().min(1, "cliAgentType is required"),
        cliAgentSessionId: z.string().min(1, "cliAgentSessionId is required"),
        cliAgentSessionHistoryHash: z
          .string()
          .length(
            64,
            "cliAgentSessionHistoryHash must be a 64-character SHA-256 hex string",
          ),
        // Multi-artifact snapshot payload. Canonical
        // `Array<{name, version, mountPath}>` form persisted verbatim to
        // checkpoints.artifact_snapshots.
        artifactSnapshots: artifactSnapshotsSchema.optional(),
        volumeVersionsSnapshot: volumeVersionsSnapshotSchema.optional(),
      })
      .strict(),
    responses: {
      200: z.object({
        checkpointId: z.string(),
        agentSessionId: z.string(),
        conversationId: z.string(),
        artifacts: artifactSnapshotsSchema.optional(),
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

export type WebhookEventsContract = typeof webhookEventsContract;
export type WebhookClerkContract = typeof webhookClerkContract;
export type WebhookGithubContract = typeof webhookGithubContract;
export type WebhookStripeContract = typeof webhookStripeContract;
export type WebhookBuiltInGenerationFalContract =
  typeof webhookBuiltInGenerationFalContract;
export type WebhookFirewallAuthContract = typeof webhookFirewallAuthContract;
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

/**
 * Webhook usage event contract for /api/webhooks/agent/usage-event
 *
 * Receives billable usage records from the sandbox for persistence in the
 * `usage_event` table. Reporters send `{ runId, events }` batches.
 */
const webhookUsageEventItemSchema = z
  .object({
    idempotencyKey: z.uuid(),
    kind: z.enum(["connector", "model", "image"]),
    provider: z.string().min(1).max(100),
    category: z.string().min(1).max(100),
    quantity: z.number().int().min(0),
  })
  .strict();

export const webhookUsageEventContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/usage-event",
    headers: authHeadersSchema,
    body: z
      .object({
        runId: z.string().min(1, "runId is required"),
        events: z.array(webhookUsageEventItemSchema).min(1).max(100),
      })
      .strict(),
    responses: {
      200: z.object({
        success: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive usage event data from sandbox",
  },
});

export type WebhookUsageEventContract = typeof webhookUsageEventContract;
