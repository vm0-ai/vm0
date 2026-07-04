import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  executionFirewallsSchema,
  networkPolicySchema,
  networkPoliciesSchema,
} from "@vm0/connectors/firewall-types";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MIN_EPOCH_MS_TIMESTAMP = 1_000_000_000_000;
const apiStartTimeSchema = z.number().int().min(MIN_EPOCH_MS_TIMESTAMP);

export const CANONICAL_GUEST_HOME_DIR = "/home/user";
export const CANONICAL_WORKING_DIR = `${CANONICAL_GUEST_HOME_DIR}/workspace`;
const CANONICAL_CLAUDE_PROJECT_NAME = CANONICAL_WORKING_DIR.replace(
  /^\//,
  "",
).replace(/\//g, "-");
export const CANONICAL_CLAUDE_MEMORY_MOUNT_PATH = `${CANONICAL_GUEST_HOME_DIR}/.claude/projects/-${CANONICAL_CLAUDE_PROJECT_NAME}/memory`;
export const CANONICAL_CODEX_MEMORY_MOUNT_PATH = `${CANONICAL_GUEST_HOME_DIR}/.codex/memories`;
// Shared resume history size contract. Rust consumers import the generated
// binding from `api_contracts::generated::constants`.
export const RESUME_SESSION_HISTORY_MAX_BYTES = 128 * 1024 * 1024;
export const SESSION_HISTORY_ENCODING_IDENTITY = "identity";
export const SESSION_HISTORY_ENCODING_GZIP = "gzip";
export const SESSION_HISTORY_GZIP_MIN_BYTES = 64 * 1024;
export const NETWORK_POLICY_REFRESH_CONNECTOR_REFS_MAX = 256;
export const sessionHistoryEncodingSchema = z.enum([
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
]);

export function elapsedSinceApiStartMs(
  apiStartTimeMs: number | undefined,
  nowMs: number,
): number | undefined {
  if (
    apiStartTimeMs === undefined ||
    !Number.isInteger(apiStartTimeMs) ||
    apiStartTimeMs < MIN_EPOCH_MS_TIMESTAMP
  ) {
    return undefined;
  }

  return Math.max(0, nowMs - apiStartTimeMs);
}

export const runnerClaimPollReasonSchema = z.enum([
  "immediate",
  "deferred",
  "wakeup_retry",
  "slow",
  "fast",
]);

const runnerClaimDiscoverySourceSchema = z.enum(["ably", "poll"]);

const runnerClaimTelemetrySchema = z.object({
  discoverySource: runnerClaimDiscoverySourceSchema.optional(),
  jobDiscoveredToClaimRequestMs: z.number().int().nonnegative().optional(),
  localAdmissionToClaimRequestMs: z.number().int().nonnegative().optional(),
  pollDueToJobDiscoveredMs: z.number().int().nonnegative().optional(),
  pollHttpRequestMs: z.number().int().nonnegative().optional(),
  pollReason: runnerClaimPollReasonSchema.optional(),
});

const runnerPollTelemetrySchema = z.object({
  pollReason: runnerClaimPollReasonSchema.optional(),
});

const runnerProfileListSchema = z.array(z.string());

const networkPolicyRefreshSchema = z.object({
  nextRefreshAt: z.string().datetime({ offset: true }),
});

const networkPolicyRefreshesSchema = z.record(
  z.string(),
  networkPolicyRefreshSchema,
);

/**
 * Default profile when none is specified.
 * Must stay in sync with Rust: crates/runner/src/profile.rs → DEFAULT_PROFILE
 */
export const DEFAULT_PROFILE = "vm0/default";

/**
 * Runner group format: vm0/<name> (e.g., "vm0/production")
 */
export const runnerGroupSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+\/[a-z0-9-]+$/,
    "Runner group must be in vm0/<name> format (e.g., vm0/production)",
  );

const runnersPollBodySchema = z
  .object({
    group: runnerGroupSchema,
    supportedProfiles: runnerProfileListSchema.optional(),
    profiles: runnerProfileListSchema.optional(),
    telemetry: runnerPollTelemetrySchema.optional(),
  })
  .superRefine((body, ctx) => {
    const supportedProfiles = body.supportedProfiles ?? body.profiles;
    if (supportedProfiles !== undefined && supportedProfiles.length > 0) {
      return;
    }

    ctx.addIssue({
      code: "custom",
      path: ["supportedProfiles"],
      message: "supportedProfiles is required",
    });
  });

/**
 * Job schema for polling response
 */
export const jobSchema = z.object({
  runId: z.uuid(),
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  agentComposeVersionId: z.string().nullable(),
  vars: z.record(z.string(), z.string()).nullable(),
  checkpointId: z.uuid().nullable(),
  experimentalProfile: z.string().optional(),
  cliAgentSessionId: z.string().nullable().optional(),
  affinityProtectedUntil: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
});

export const heldSessionStateSchema = z.object({
  // Compatibility wire name. Semantically this is the Claude/Codex CLI agent
  // session id used to route work toward a runner with a reusable sandbox.
  sessionId: z.string(),
  lastCompletedAt: z.string().datetime({ offset: true }),
});

/**
 * Runners poll contract - POST /api/runners/poll
 * Long-polling endpoint to fetch pending jobs for a runner group
 *
 * NOTE: Uses POST instead of GET to avoid CDN caching issues on preview deployments.
 * POST requests are never cached, ensuring the Authorization header is always read fresh.
 */
export const runnersPollContract = c.router({
  poll: {
    method: "POST",
    path: "/api/runners/poll",
    headers: authHeadersSchema,
    body: runnersPollBodySchema,
    responses: {
      200: z.object({
        job: jobSchema.nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Poll for pending jobs (long-polling with 30s timeout)",
  },
});

/**
 * Storage entry in manifest
 */
export const storageEntrySchema = z.object({
  name: z.string(),
  mountPath: z.string(),
  vasStorageName: z.string(),
  vasVersionId: z.string(),
  instructionsTargetFilename: z.string().optional(),
  archiveUrl: z.string(),
});

/**
 * Artifact entry in manifest
 */
// Optional internal checkpoint behavior for a missing artifact root. Absence
// is equivalent to "fail".
export const artifactMissingRootPolicySchema = z.enum([
  "fail",
  "preserveParentVersion",
]);

export const artifactEntrySchema = z.object({
  mountPath: z.string(),
  vasStorageName: z.string(),
  vasStorageId: z.string(),
  vasVersionId: z.string(),
  archiveUrl: z.string(),
  missingRootPolicy: artifactMissingRootPolicySchema.optional(),
});

/**
 * Storage manifest with presigned URLs for download
 */
export const storageManifestSchema = z.object({
  storages: z.array(storageEntrySchema),
  artifacts: z.array(artifactEntrySchema),
});

/**
 * Resume session information. The compatibility wire field is `sessionId`, but
 * its semantic name in API/runner code is `cliAgentSessionId`.
 */
const inlineResumeSessionSchema = z.object({
  sessionId: z.string(),
  sessionHistory: z.string(),
});

const resumeSessionHistoryBlobRefSchema = z.object({
  kind: z.literal("blob"),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const resumeSessionHistoryRawSizeSchema = z
  .number()
  .int()
  .positive()
  .max(RESUME_SESSION_HISTORY_MAX_BYTES);
const resumeSessionHistoryEncodedSizeSchema = z
  .number()
  .int()
  .positive()
  .max(RESUME_SESSION_HISTORY_MAX_BYTES);

const storedResumeSessionRefSchema = z.object({
  sessionId: z.string(),
  historyRef: resumeSessionHistoryBlobRefSchema.extend({
    encoding: sessionHistoryEncodingSchema.optional(),
  }),
});

const resumeSessionIdentityHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("identity").optional(),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
  })
  .strict();

const resumeSessionGzipHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("gzip"),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
  })
  .strict();

const resumeSessionRefSchema = z.object({
  sessionId: z.string(),
  historyRef: z.union([
    resumeSessionGzipHistoryRefSchema,
    resumeSessionIdentityHistoryRefSchema,
  ]),
});

export const storedResumeSessionSchema = z.union([
  inlineResumeSessionSchema,
  storedResumeSessionRefSchema,
]);

export const resumeSessionSchema = z.union([
  inlineResumeSessionSchema,
  resumeSessionRefSchema,
]);

// Capability names are intentionally open-ended so a newer runner can claim
// jobs through an older API; the API ignores capabilities it does not know.
export const runnerClaimCapabilitySchema = z.string().min(1);

export const secretConnectorMetadataSchema = z.object({
  sourceType: z.enum(["connector", "model-provider"]),
  sourceUserId: z.string().optional(),
  metadataKey: z.string().optional(),
});

// Keyed by the same firewall auth secret env aliases as secretConnectorMap.
export const secretConnectorMetadataMapSchema = z.record(
  z.string(),
  secretConnectorMetadataSchema,
);

/**
 * Stored execution context (subset stored in database for late routing)
 * Contains prepared context without runtime-generated fields
 * Secrets are encrypted with AES-256-GCM before storage
 */
export const storedExecutionContextSchema = z.object({
  storageManifest: storageManifestSchema.nullable(),
  environment: z.record(z.string(), z.string()).nullable(),
  resumeSession: storedResumeSessionSchema.nullable(),
  // AES-256-GCM encrypted Record<string, string>. Keys are the runtime secret
  // names used by `${{ secrets.NAME }}`; connector/model-provider keys are env
  // aliases, not backing storage secret names.
  encryptedSecrets: z.string().nullable(),
  // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`) to
  // their connector or provider owner. Keys are env aliases, not storage secret names.
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: z.string(),
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: z.boolean().optional(),
  // Debug flag to force real Codex in mock environments (internal use only)
  debugNoMockCodex: z.boolean().optional(),
  // Capture HTTP header names, selected safe header values, request bodies, and response bodies
  // in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
  // Firewall entries for proxy-side token replacement. Built-ins stay compact;
  // org custom connectors use inline firewall bodies.
  firewalls: executionFirewallsSchema.optional(),
  // Per-firewall network policies: which permissions are granted + unknownPolicy
  networkPolicies: networkPoliciesSchema.optional(),
  // Per-connector runtime network policy refresh deadlines. Used by runners to refresh
  // active sandbox policy when temporary allow grants expire.
  networkPolicyRefreshes: networkPolicyRefreshesSchema.optional(),
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: z.array(z.string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: z.array(z.string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: z.string().optional(),
  // VM profile for resource allocation (e.g., "vm0/default")
  experimentalProfile: z.string().optional(),
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  billableFirewalls: z.array(z.string()).optional(),
  // Canonical model id the proxy reports for model token usage. The API uses
  // this model id for built-in billing rows and model usage observations;
  // billing eligibility is decided from API-owned run context.
  modelUsageProvider: z.string().optional(),
});

/**
 * Execution context returned when claiming a job.
 *
 * Keep in sync with Rust: crates/runner/src/types.rs → ExecutionContext
 */
export const executionContextSchema = z.object({
  runId: z.uuid(),
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  agentComposeVersionId: z.string().nullable(),
  vars: z.record(z.string(), z.string()).nullable(),
  checkpointId: z.uuid().nullable(),
  sandboxToken: z.string(),
  storageManifest: storageManifestSchema.nullable(),
  environment: z.record(z.string(), z.string()).nullable(),
  resumeSession: resumeSessionSchema.nullable(),
  // Plain secret values used by the runner for redaction. These are values, not
  // names, and are base64-encoded only when exported through VM0_SECRET_VALUES.
  secretValues: z.array(z.string()).nullable(),
  // AES-256-GCM encrypted Record<string, string>, passed through to mitm-addon
  // for auth resolution. Keys are runtime secret names used by
  // `${{ secrets.NAME }}`; connector/model-provider keys are env aliases, not
  // backing storage secret names.
  encryptedSecrets: z.string().nullable(),
  // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`) to
  // their connector or provider owner. Keys are env aliases, not storage secret names.
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: z.string(),
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: z.boolean().optional(),
  // Debug flag to force real Codex in mock environments (internal use only)
  debugNoMockCodex: z.boolean().optional(),
  // Capture HTTP header names, selected safe header values, request bodies, and response bodies
  // in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
  // Firewall entries for proxy-side token replacement. Built-ins stay compact;
  // org custom connectors use inline firewall bodies.
  firewalls: executionFirewallsSchema.optional(),
  // Per-firewall network policies: which permissions are granted + unknownPolicy
  networkPolicies: networkPoliciesSchema.optional(),
  // Per-connector runtime network policy refresh deadlines. Used by runners to refresh
  // active sandbox policy when temporary allow grants expire.
  networkPolicyRefreshes: networkPolicyRefreshesSchema.optional(),
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: z.array(z.string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: z.array(z.string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: z.string().optional(),
  // VM profile for resource allocation (e.g., "vm0/default")
  experimentalProfile: z.string().optional(),
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  billableFirewalls: z.array(z.string()).optional(),
  // Canonical model id the proxy reports for model token usage. The API uses
  // this model id for built-in billing rows and model usage observations;
  // billing eligibility is decided from API-owned run context.
  modelUsageProvider: z.string().optional(),
});

/**
 * Runners job claim contract - POST /api/runners/jobs/:id/claim
 * Claim a pending job for execution
 * Verifies that the job's agent_run belongs to the authenticated user
 */
export const runnersJobClaimContract = c.router({
  claim: {
    method: "POST",
    path: "/api/runners/jobs/:id/claim",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.uuid(),
    }),
    body: z.object({
      telemetry: runnerClaimTelemetrySchema.optional(),
      capabilities: z.array(runnerClaimCapabilitySchema).optional(),
    }),
    responses: {
      200: executionContextSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema, // Job does not belong to user
      404: apiErrorSchema,
      409: apiErrorSchema, // Already claimed
      500: apiErrorSchema,
    },
    summary: "Claim a pending job for execution",
  },
});

export const runnersNetworkPolicyRefreshContract = c.router({
  refresh: {
    method: "POST",
    path: "/api/runners/runs/:runId/network-policy-refresh",
    headers: authHeadersSchema,
    pathParams: z.object({
      runId: z.uuid(),
    }),
    body: z.object({
      connectorRefs: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(NETWORK_POLICY_REFRESH_CONNECTOR_REFS_MAX),
    }),
    responses: {
      200: z.object({
        refreshes: z.array(
          z.object({
            connectorRef: z.string(),
            networkPolicy: networkPolicySchema,
            nextRefreshAt: z.string().datetime({ offset: true }).nullable(),
          }),
        ),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Refresh active run network policies",
  },
});

/**
 * Runner heartbeat body — periodic state report from each runner
 */
export const heartbeatBodySchema = z
  .object({
    runnerId: z.uuid(),
    runnerName: z.string(),
    group: runnerGroupSchema,
    profiles: runnerProfileListSchema.optional(),
    totalVcpu: z.number().int().nonnegative(),
    totalMemoryMb: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().nonnegative(),
    allocatedVcpu: z.number().int().nonnegative(),
    allocatedMemoryMb: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    admittableProfiles: runnerProfileListSchema.optional(),
    availableProfiles: runnerProfileListSchema.optional(),
    heldSessionStates: z.array(heldSessionStateSchema).max(1024),
    mode: z.enum(["running", "draining", "stopping"]),
  })
  .superRefine((body, ctx) => {
    if (
      body.admittableProfiles !== undefined ||
      body.availableProfiles !== undefined ||
      body.profiles !== undefined
    ) {
      return;
    }

    ctx.addIssue({
      code: "custom",
      path: ["admittableProfiles"],
      message: "admittableProfiles is required",
    });
  });

/**
 * Runners heartbeat contract - POST /api/runners/heartbeat
 * Periodic state report from runners for capacity tracking and dispatch
 */
export const runnersHeartbeatContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/api/runners/heartbeat",
    headers: authHeadersSchema,
    body: heartbeatBodySchema,
    responses: {
      200: z.object({ ok: z.literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Report runner heartbeat with capacity and state",
  },
});

export type RunnersPollContract = typeof runnersPollContract;
export type RunnersJobClaimContract = typeof runnersJobClaimContract;
export type RunnersNetworkPolicyRefreshContract =
  typeof runnersNetworkPolicyRefreshContract;
export type RunnersHeartbeatContract = typeof runnersHeartbeatContract;
export type Job = z.infer<typeof jobSchema>;
export type HeldSessionState = z.infer<typeof heldSessionStateSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type StoredExecutionContext = z.infer<
  typeof storedExecutionContextSchema
>;
export type NetworkPolicyRefresh = z.infer<typeof networkPolicyRefreshSchema>;
export type SecretConnectorMetadata = z.infer<
  typeof secretConnectorMetadataSchema
>;
export type StorageEntry = z.infer<typeof storageEntrySchema>;
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>;
export type StorageManifest = z.infer<typeof storageManifestSchema>;
export type StoredResumeSession = z.infer<typeof storedResumeSessionSchema>;
export type ResumeSession = z.infer<typeof resumeSessionSchema>;

export type RunnerClaimCapability = z.infer<typeof runnerClaimCapabilitySchema>;
