import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  artifactMissingRootPolicySchema,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  sandboxReuseResultSchema,
  sessionHistoryDownloadSourceSchema,
  sessionHistoryEncodingSchema,
  sessionHistorySizeBucketSchema,
  secretConnectorMetadataMapSchema,
} from "./runners";
import { eventSequenceNumberSchema, networkLogEntrySchema } from "./runs";
import {
  fileEntryWithHashSchema,
  storageChangesSchema,
  presignedUploadSchema,
} from "./storages";

export { sandboxReuseResultSchema, type SandboxReuseResult } from "./runners";

const c = initContract();

// Hash-backed resume history is keyed and verified as lowercase SHA-256 hex.
// Accepting other 64-character strings would defer bad input until runner claim.
const sha256HexSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    "hash must be a lowercase 64-character SHA-256 hex string",
  );

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

const gmailWebhookResponseSchema = z.object({
  success: z.literal(true),
  watchStates: z.number(),
  dispatched: z.number(),
  duplicates: z.number(),
});

const googleCalendarWebhookResponseSchema = z.object({
  success: z.literal(true),
  watchStates: z.number(),
  dispatched: z.number(),
  duplicates: z.number(),
});

const googleWorkspaceEventsWebhookResponseSchema = z.object({
  success: z.literal(true),
  watchStates: z.number(),
  dispatched: z.number(),
  duplicates: z.number(),
});

const notionWebhookResponseSchema = z.object({
  success: z.literal(true),
  kind: z.enum(["verification", "event"]),
  pending: z.number(),
  refreshed: z.number(),
  duplicates: z.number(),
});

const workflowAutomationWebhookResponseSchema = z.object({
  success: z.literal(true),
  duplicate: z.boolean(),
  runId: z.string().uuid().optional(),
});

/**
 * Gmail Pub/Sub push webhook contract for /api/webhooks/gmail.
 */
export const webhookGmailContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/gmail",
    body: c.type<string>(),
    responses: {
      200: gmailWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Gmail Pub/Sub push notifications",
  },
});

/**
 * Google Calendar push webhook contract for /api/webhooks/google-calendar.
 */
export const webhookGoogleCalendarContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-calendar",
    body: c.type<string>(),
    responses: {
      200: googleCalendarWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Calendar push notifications",
  },
});

/**
 * Google Workspace Events Pub/Sub push webhook contract for
 * /api/webhooks/google-workspace-events.
 */
export const webhookGoogleWorkspaceEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-workspace-events",
    body: c.type<string>(),
    responses: {
      200: googleWorkspaceEventsWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Workspace Events Pub/Sub push notifications",
  },
});

/**
 * Notion webhook contract for /api/webhooks/notion.
 */
export const webhookNotionContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/notion",
    body: c.type<string>(),
    responses: {
      200: notionWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Notion webhook events",
  },
});

const workflowAutomationWebhookPostRoute = {
  method: "POST" as const,
  pathParams: z.object({
    token: z.string().min(1),
  }),
  body: c.type<string>(),
  responses: {
    200: workflowAutomationWebhookResponseSchema,
    400: thirdPartyWebhookErrorSchema,
    401: thirdPartyWebhookErrorSchema,
    404: thirdPartyWebhookErrorSchema,
    413: thirdPartyWebhookErrorSchema,
    429: thirdPartyWebhookErrorSchema,
    500: thirdPartyWebhookErrorSchema,
  },
};

/**
 * Workflow automation inbound webhook contract for
 * /api/webhooks/workflow-automations/:token.
 */
export const webhookWorkflowAutomationContract = c.router({
  post: {
    ...workflowAutomationWebhookPostRoute,
    path: "/api/webhooks/workflow-automations/:token",
    summary: "Handle inbound workflow automation webhooks",
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

export const webhookBuiltInGenerationBytePlusContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/built-in-generations/byteplus/:generationId",
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
    summary: "Handle BytePlus built-in generation webhooks",
  },
});

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
 * Artifact snapshots schema — canonical
 * `Array<{name, version, mountPath, missingRootPolicy?}>` form. Legacy
 * `Record<name, version>` support was removed in #10913 after the DB
 * migration and guest-agent writer flip completed.
 */
const artifactSnapshotsSchema = z.array(
  z.object({
    name: z.string(),
    version: z.string(),
    mountPath: z.string(),
    missingRootPolicy: artifactMissingRootPolicySchema.optional(),
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
    failureReason: z
      .enum(["upstream_provider", "reconnect_required"])
      .optional(),
  }),
});

const firewallAwsSigv4AuthSchema = z
  .object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1).optional(),
  })
  .strict();

const firewallAuthResponseSchema = z.object({
  headers: z.record(z.string(), z.string()),
  base: z.string().optional(),
  query: z.record(z.string(), z.string()).optional(),
  awsSigv4: firewallAwsSigv4AuthSchema.optional(),
  // Effective addon cache expiry as Unix seconds. Access token expiry is the
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
   * Resolve firewall auth templates and refresh access tokens on demand.
   */
  resolve: {
    method: "POST",
    path: "/api/webhooks/agent/firewall/auth",
    headers: authHeadersSchema,
    body: z.object({
      // Encrypted runtime secret namespace. After decryption, keys are the
      // `NAME` in `${{ secrets.NAME }}`.
      encryptedSecrets: z.string().min(1),
      authHeaders: z.record(z.string(), z.string()),
      authBase: z.string().optional(),
      authQuery: z.record(z.string(), z.string()).optional(),
      authAwsSigv4: firewallAwsSigv4AuthSchema.optional(),
      // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`)
      // to the connector or provider owner that can refresh/resolve access.
      // TODO(#23619): Split connector slugs from provider keys before renaming
      // this firewall-auth wire field.
      secretConnectorMap: z.record(z.string(), z.string()).optional(),
      // Same keys as secretConnectorMap; adds source details when the owner
      // alone is not enough to locate access storage.
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
        cancellationFinalizationRequired: z.literal(true).optional(),
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
        cliAgentSessionHistoryHash: sha256HexSchema,
        // Multi-artifact snapshots are folded into canonical checkpoint mounts
        // and projected back into the legacy response shape.
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
      hash: sha256HexSchema,
      rawSize: z
        .number()
        .int()
        .positive("rawSize must be a positive integer")
        .max(RESUME_SESSION_HISTORY_MAX_BYTES),
      encodedSize: z
        .number()
        .int()
        .positive("encodedSize must be a positive integer")
        .max(RESUME_SESSION_HISTORY_MAX_BYTES),
      encoding: sessionHistoryEncodingSchema.optional(),
    }),
    responses: {
      200: z.object({
        presignedUrl: z.string().optional(),
        existing: z.boolean(),
        encoding: sessionHistoryEncodingSchema.optional(),
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

const sessionHistoryCompressionRatioBucketSchema = z.enum([
  "identity",
  "lt_0_25",
  "0_25_0_5",
  "0_5_0_75",
  "0_75_1",
  "ge_1",
]);

const booleanStringSchema = z.enum(["true", "false"]);

const sessionHistoryContentLengthStateSchema = z.enum([
  "absent",
  "matches_expected",
  "mismatches_expected",
  "present_without_expected",
  "oversized",
]);

const sessionHistoryContentEncodingStateSchema = z.enum([
  "absent",
  "gzip",
  "zstd",
  "other",
]);

const sessionHistoryTransferEncodingStateSchema = z.enum([
  "absent",
  "chunked",
  "other",
]);

const sandboxOperationDownloadSourceSchema = z
  .preprocess((value) => {
    const parsed = sessionHistoryDownloadSourceSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    if (typeof value === "string") {
      return undefined;
    }
    return value;
  }, sessionHistoryDownloadSourceSchema.optional())
  .optional();

/**
 * Sandbox operation schema for internal sandbox operations (init, storage, cli, checkpoint, cleanup)
 */
const sandboxOperationSchema = z.object({
  ts: z.string(),
  action_type: z.string(),
  duration_ms: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
  encoding: sessionHistoryEncodingSchema.optional(),
  session_history_raw_size_bucket: sessionHistorySizeBucketSchema.optional(),
  session_history_encoded_size_bucket:
    sessionHistorySizeBucketSchema.optional(),
  session_history_compression_ratio_bucket:
    sessionHistoryCompressionRatioBucketSchema.optional(),
  session_history_ref_seen_recently: booleanStringSchema.optional(),
  session_history_ref_download_inflight: booleanStringSchema.optional(),
  session_history_content_length_state:
    sessionHistoryContentLengthStateSchema.optional(),
  session_history_content_encoding_state:
    sessionHistoryContentEncodingStateSchema.optional(),
  session_history_transfer_encoding_state:
    sessionHistoryTransferEncodingStateSchema.optional(),
  session_history_download_source: sandboxOperationDownloadSourceSchema,
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
      /**
       * Canonical Storage identity authorized against the run's writeback
       * mounts.
       */
      storageId: z.string().uuid(),
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
      /**
       * Canonical Storage identity authorized against the run's writeback
       * mounts.
       */
      storageId: z.string().uuid(),
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
export type WebhookGmailContract = typeof webhookGmailContract;
export type WebhookGoogleCalendarContract =
  typeof webhookGoogleCalendarContract;
export type WebhookGoogleWorkspaceEventsContract =
  typeof webhookGoogleWorkspaceEventsContract;
export type WebhookStripeContract = typeof webhookStripeContract;
export type WebhookWorkflowAutomationContract =
  typeof webhookWorkflowAutomationContract;
export type WebhookBuiltInGenerationFalContract =
  typeof webhookBuiltInGenerationFalContract;
export type WebhookBuiltInGenerationBytePlusContract =
  typeof webhookBuiltInGenerationBytePlusContract;
export type WebhookFirewallAuthContract = typeof webhookFirewallAuthContract;
export type WebhookCompleteContract = typeof webhookCompleteContract;
export type WebhookCheckpointsContract = typeof webhookCheckpointsContract;
export type WebhookCheckpointsPrepareHistoryContract =
  typeof webhookCheckpointsPrepareHistoryContract;
export type WebhookHeartbeatContract = typeof webhookHeartbeatContract;
export type WebhookTelemetryContract = typeof webhookTelemetryContract;
export type WebhookStoragesPrepareContract =
  typeof webhookStoragesPrepareContract;
export type WebhookStoragesCommitContract =
  typeof webhookStoragesCommitContract;

/**
 * Webhook usage event contract for /api/webhooks/agent/usage-event
 *
 * Receives billing usage records from the sandbox for persistence in the
 * `usage_event` ledger. Reporters send `{ runId, events }` batches, and the
 * API prices their quantities from the server-side pricing table.
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
    summary: "Receive billing usage event data from sandbox",
  },
});

const webhookModelUsageObservationItemSchema = z
  .object({
    idempotencyKey: z.uuid(),
    model: z.string().min(1).max(255),
    inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cacheReadInputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cacheCreationInputTokens: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (event) => {
      return (
        event.inputTokens > 0 ||
        event.outputTokens > 0 ||
        event.cacheReadInputTokens > 0 ||
        event.cacheCreationInputTokens > 0
      );
    },
    { message: "At least one token counter must be positive" },
  );

const webhookModelUsageObservationBodySchema = z
  .object({
    runId: z.string().min(1, "runId is required"),
    events: z.array(webhookModelUsageObservationItemSchema).min(1).max(100),
  })
  .strict()
  .superRefine((body, ctx) => {
    const idempotencyKeys = new Set<string>();
    body.events.forEach((event, index) => {
      if (idempotencyKeys.has(event.idempotencyKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "idempotencyKey"],
          message: "Idempotency keys must be unique within a request",
        });
      }
      idempotencyKeys.add(event.idempotencyKey);
    });
  });

/**
 * Compact model usage observation contract for
 * /api/webhooks/agent/model-usage-observation
 *
 * Each immutable event carries the four counters consumed by model rankings.
 */
export const webhookModelUsageObservationContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/model-usage-observation",
    headers: authHeadersSchema,
    body: webhookModelUsageObservationBodySchema,
    responses: {
      200: z.object({
        success: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive compact model usage observation data from sandbox",
  },
});

export type WebhookUsageEventContract = typeof webhookUsageEventContract;
export type WebhookModelUsageObservationContract =
  typeof webhookModelUsageObservationContract;
