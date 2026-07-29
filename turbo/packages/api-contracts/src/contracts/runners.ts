import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  executionFirewallsSchema,
  firewallPolicyValueSchema,
  firewallSchema,
  networkPolicySchema,
  networkPoliciesSchema,
} from "@vm0/connectors/firewall-types";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { modelProviderCodexRuntimeConfigSchema } from "./model-providers";

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
export const SESSION_HISTORY_ENCODING_ZSTD = "zstd";
export const SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT =
  "configured_public_endpoint";
export const SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT =
  "default_r2_endpoint";
export const SESSION_HISTORY_GZIP_MIN_BYTES = 64 * 1024;
// TODO(#23619): Rename with the generated runner constant in a compatible
// runner/API rollout.
export const NETWORK_POLICY_REFRESH_CONNECTOR_REFS_MAX = 256;
export const RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX = 512;
export const sessionHistoryEncodingSchema = z.enum([
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_ZSTD,
]);
export const sessionHistoryDownloadSourceSchema = z.enum([
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
]);
export const sessionHistorySizeBucketSchema = z.enum([
  "lt_64_kib",
  "64_256_kib",
  "256_kib_1_mib",
  "1_4_mib",
  "4_16_mib",
  "16_64_mib",
  "64_128_mib",
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

export const sessionAffinityResourceSchema = z.enum([
  "reusableSandbox",
  "workspaceCache",
]);

const runnerClaimDiscoverySourceSchema = z.enum(["ably", "poll"]);
const runnerClaimTelemetrySchema = z
  .object({
    discoverySource: runnerClaimDiscoverySourceSchema.optional(),
    jobDiscoveredToClaimRequestMs: z.number().int().nonnegative().optional(),
    localAdmissionToClaimRequestMs: z.number().int().nonnegative().optional(),
    directCandidateNotificationToEnqueueMs: z
      .number()
      .int()
      .nonnegative()
      .optional(),
    directCandidateInboxWaitMs: z.number().int().nonnegative().optional(),
    providerDiscoveryToMainLoopMs: z.number().int().nonnegative().optional(),
    mainLoopToLocalAdmissionMs: z.number().int().nonnegative().optional(),
    pollDueToJobDiscoveredMs: z.number().int().nonnegative().optional(),
    pollHttpRequestMs: z.number().int().nonnegative().optional(),
    pollReason: runnerClaimPollReasonSchema.optional(),
  })
  .catch({});

const runnerPollTelemetrySchema = z
  .object({
    pollReason: runnerClaimPollReasonSchema.optional(),
  })
  .catch({});

const runnerProfileListSchema = z.array(z.string());
const runnerSupportedProfileListSchema = runnerProfileListSchema.min(1);
export const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX = 128;

const networkPolicyRefreshSchema = z.object({
  nextRefreshAt: z.string().datetime({ offset: true }),
});

const networkPolicyRefreshesSchema = z.record(
  z.string(),
  networkPolicyRefreshSchema,
);
const connectorPermissionNameListSchema = z
  .array(z.string().min(1))
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "Connector permission names must be unique",
      });
    }
  });
const connectorPermissionDefaultOverridesSchema = z
  .object({
    allow: connectorPermissionNameListSchema.optional(),
    deny: connectorPermissionNameListSchema.optional(),
    ask: connectorPermissionNameListSchema.optional(),
  })
  .strict();
const connectorPermissionBaselineEntrySchema = z
  .object({
    permissionNames: connectorPermissionNameListSchema,
    defaultPolicy: z
      .object({
        permissionDefault: firewallPolicyValueSchema,
        permissionOverrides:
          connectorPermissionDefaultOverridesSchema.optional(),
        unknownPolicy: firewallPolicyValueSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((entry, context) => {
    const permissionNames = new Set(entry.permissionNames);
    const overrideNames = Object.values(
      entry.defaultPolicy.permissionOverrides ?? {},
    ).flat();
    if (new Set(overrideNames).size !== overrideNames.length) {
      context.addIssue({
        code: "custom",
        path: ["defaultPolicy", "permissionOverrides"],
        message: "Connector permission overrides must not overlap",
      });
    }
    for (const permissionName of overrideNames) {
      if (!permissionNames.has(permissionName)) {
        context.addIssue({
          code: "custom",
          path: ["defaultPolicy", "permissionOverrides"],
          message: "Connector permission override must name a permission",
        });
      }
    }
  });
const connectorCatalogDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const connectorCatalogBackendVersionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
const connectorCatalogBuildCommitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/u);

export const storedConnectorPermissionBaselineSchema = z
  .object({
    version: z.literal(1),
    catalogIdentity: z
      .object({
        sourceId: z.string().min(1),
        schemaVersion: z.number().int().positive(),
        catalogVersion: z.string().min(1),
        catalogDigest: connectorCatalogDigestSchema,
        capabilityDigest: connectorCatalogDigestSchema,
      })
      .strict(),
    validationAuthority: z
      .object({
        backendVersion: connectorCatalogBackendVersionSchema,
        buildCommitSha: connectorCatalogBuildCommitShaSchema.nullable(),
      })
      .strict(),
    connectors: z.record(
      connectorSlugSchema,
      connectorPermissionBaselineEntrySchema,
    ),
  })
  .strict();
const runnerBuiltinFirewallNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:[a-z0-9][a-z0-9-]*|model-provider:[a-z0-9][a-z0-9-]*)$/);
const runnerBuiltinFirewallsResolveBodySchema = z
  .object({
    names: z
      .array(runnerBuiltinFirewallNameSchema)
      .min(1)
      .max(RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX)
      .optional(),
  })
  .strict();
const runnerBuiltinFirewallsResolveResponseSchema = z.object({
  catalogDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  catalogVersion: z.string().min(1),
  firewalls: z.record(runnerBuiltinFirewallNameSchema, firewallSchema),
});

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

const runnersPollBodySchema = z.object({
  runnerId: z.uuid().optional(),
  group: runnerGroupSchema,
  supportedProfiles: runnerSupportedProfileListSchema,
  excludedRunIds: z
    .array(z.uuid())
    .max(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX)
    .optional(),
  telemetry: runnerPollTelemetrySchema.optional(),
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
  experimentalProfile: z.string(),
  cliAgentSessionId: z.string().nullable().optional(),
  historyGenerationRunId: z.uuid().optional(),
  historyGenerationAffinityProtectedUntil: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
  affinityProtectedUntil: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
  sessionAffinityResource: sessionAffinityResourceSchema.optional(),
});

export const heldSessionStateSchema = z.object({
  // Compatibility wire name. Semantically this is the Claude/Codex CLI agent
  // session id used to route work toward a runner with a reusable sandbox.
  sessionId: z.string(),
  lastCompletedAt: z.string().datetime({ offset: true }),
  reusableSandbox: z
    .object({
      profile: z.string(),
      historyGenerationRunId: z.uuid().optional(),
    })
    .optional(),
  workspaceCaches: z
    .array(
      z.object({
        profile: z.string(),
        workspaceAffinityVersion: z.literal(1).optional(),
      }),
    )
    .max(8)
    .optional(),
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

const archiveSizeSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// Optional internal checkpoint behavior for a missing artifact root. Absence
// is equivalent to "fail".
export const artifactMissingRootPolicySchema = z.enum([
  "fail",
  "preserveParentVersion",
]);

/**
 * Canonical resolved Storage mount emitted to runners.
 */
export const storageMountEntrySchema = z
  .object({
    name: z.string(),
    storageId: z.string(),
    versionId: z.string(),
    mountPath: z.string(),
    archiveUrl: z.string().optional(),
    archiveSize: archiveSizeSchema.optional(),
    empty: z.boolean().optional(),
    instructionsTargetFilename: z.string().optional(),
    missingRootPolicy: artifactMissingRootPolicySchema.optional(),
    writeback: z.boolean().optional(),
  })
  .superRefine((mount, ctx) => {
    const writeback = mount.writeback ?? false;
    if (
      mount.archiveUrl === undefined &&
      !(writeback && mount.empty === true)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archiveUrl"],
        message:
          "archiveUrl is required unless an empty writeback mount is requested",
      });
    }
    if (!writeback && mount.empty === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["empty"],
        message: "empty is only valid for writeback mounts",
      });
    }
    if (writeback && mount.instructionsTargetFilename !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instructionsTargetFilename"],
        message: "instructionsTargetFilename is not valid for writeback mounts",
      });
    }
    if (!writeback && mount.missingRootPolicy !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missingRootPolicy"],
        message: "missingRootPolicy is only valid for writeback mounts",
      });
    }
  });

/**
 * Canonical resolved Storage mount persisted by the API before claim-time
 * capability negotiation. Ownership is API-only metadata and is intentionally
 * omitted from the Runner wire representation.
 */
export const storedStorageMountEntrySchema = storageMountEntrySchema.extend({
  orgId: z.string(),
  userId: z.string(),
});

function uniqueStorageMountPaths<T extends { readonly mountPath: string }>(
  mounts: readonly T[],
  ctx: z.RefinementCtx,
): void {
  const mountPaths = new Set<string>();
  for (const [index, mount] of mounts.entries()) {
    if (mountPaths.has(mount.mountPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "mountPath"],
        message: `Duplicate Storage mount path "${mount.mountPath}"`,
      });
    }
    mountPaths.add(mount.mountPath);
  }
}

/** Canonical Runner wire representation. */
export const storageManifestSchema = z.object({
  storageMounts: z
    .array(storageMountEntrySchema)
    .superRefine(uniqueStorageMountPaths),
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
const resumeSessionHistoryDownloadSourceFieldSchema = {
  downloadSource: sessionHistoryDownloadSourceSchema.optional(),
};
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
  historyGenerationRunId: z.uuid().optional(),
  historyRef: resumeSessionHistoryBlobRefSchema.extend({
    encoding: sessionHistoryEncodingSchema.optional(),
  }),
});

const resumeSessionIdentityHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("identity"),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
    ...resumeSessionHistoryDownloadSourceFieldSchema,
  })
  .strict();

const resumeSessionGzipHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("gzip"),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
    ...resumeSessionHistoryDownloadSourceFieldSchema,
  })
  .strict();

const resumeSessionZstdHistoryRefSchema = resumeSessionHistoryBlobRefSchema
  .extend({
    url: z.string().url(),
    encoding: z.literal("zstd"),
    rawSize: resumeSessionHistoryRawSizeSchema,
    encodedSize: resumeSessionHistoryEncodedSizeSchema,
    ...resumeSessionHistoryDownloadSourceFieldSchema,
  })
  .strict();

const resumeSessionRefSchema = z.object({
  sessionId: z.string(),
  historyRef: z.union([
    resumeSessionGzipHistoryRefSchema,
    resumeSessionZstdHistoryRefSchema,
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
  sourceType: z.enum(["connector", "model-provider", "platform-secret"]),
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
  storageMounts: z
    .array(storedStorageMountEntrySchema)
    .superRefine(uniqueStorageMountPaths),
  environment: z.record(z.string(), z.string()).nullable(),
  // API-only references used to reconstruct runner masking values from the
  // stored environment. Null means no persistent secret map, and array
  // order/repetition follows secret-map values.
  // This field must not be included in the runner-facing ExecutionContext.
  secretValueEnvironmentKeys: z.array(z.string()).nullable(),
  // Connector-owned runtime vars used by proxy/firewall template resolution.
  // User-provided run vars stay in agent_runs.vars and are merged at claim time.
  vars: z.record(z.string(), z.string()).nullable().optional(),
  resumeSession: storedResumeSessionSchema.nullable(),
  // AES-256-GCM encrypted Record<string, string>. Keys are the runtime secret
  // names used by `${{ secrets.NAME }}`; connector/model-provider keys are env
  // aliases, not backing storage secret names.
  encryptedSecrets: z.string().nullable(),
  // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`) to
  // their connector or provider owner. Keys are env aliases, not storage secret names.
  // TODO(#23619): Split connector slugs from provider keys before renaming this
  // persisted runner field.
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: z.string(),
  // Preview evaluation escape hatch: bypass preview mock CLIs and use the real
  // agent runtime.
  realAgentInPreview: z.boolean().optional(),
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
  // API-only catalog-derived permission defaults for claim-time grant refresh.
  connectorPermissionBaseline:
    storedConnectorPermissionBaselineSchema.optional(),
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: z.array(z.string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: z.array(z.string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: z.string().optional(),
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  billableFirewalls: z.array(z.string()).optional(),
  // Canonical model id the proxy reports for model token usage. The API uses
  // this model id for built-in billing rows and model usage observations;
  // billing eligibility is decided from API-owned run context.
  modelUsageProvider: z.string().optional(),
  // API-owned Codex provider/runtime metadata forwarded through the runner.
  codexRuntimeConfig: modelProviderCodexRuntimeConfigSchema
    .nullable()
    .optional(),
});

/**
 * Tolerant reader for execution contexts already persisted in a database or
 * encrypted queue payload. The optional baseline is derived performance data,
 * so malformed or future versions must remain an independent cache miss rather
 * than invalidating the complete queued execution context.
 */
export const compatibleStoredExecutionContextSchema =
  storedExecutionContextSchema.extend({
    connectorPermissionBaseline: z.unknown().optional(),
  });

/**
 * Execution context returned when claiming a job.
 *
 * This is the canonical producer schema. The runner's `ExecutionContext` is a
 * tolerant consumer projection and intentionally does not mirror every field.
 * See `crates/runner/src/types.rs`.
 */
export const executionContextSchema = z.object({
  runId: z.uuid(),
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  agentComposeVersionId: z.string().nullable(),
  vars: z.record(z.string(), z.string()).nullable(),
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
  // TODO(#23619): Split connector slugs from provider keys before renaming this
  // runner wire field.
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  // Same keys as secretConnectorMap; adds source details when the owner alone
  // is not enough to locate access storage (for example, personal model providers).
  secretConnectorMetadataMap: secretConnectorMetadataMapSchema
    .nullable()
    .optional(),
  cliAgentType: z.string(),
  // Preview evaluation escape hatch: bypass preview mock CLIs and use the real
  // agent runtime.
  realAgentInPreview: z.boolean().optional(),
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
  // Feature flags evaluated at job creation time (all switch states for user/org)
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  billableFirewalls: z.array(z.string()).optional(),
  // Canonical model id the proxy reports for model token usage. The API uses
  // this model id for built-in billing rows and model usage observations;
  // billing eligibility is decided from API-owned run context.
  modelUsageProvider: z.string().optional(),
  // API-owned Codex provider/runtime metadata forwarded through the runner.
  codexRuntimeConfig: modelProviderCodexRuntimeConfigSchema
    .nullable()
    .optional(),
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
      // TODO(#23619): Rename runner wire fields in a compatibility-safe rollout.
      connectorRefs: z
        .array(connectorSlugSchema)
        .min(1)
        .max(NETWORK_POLICY_REFRESH_CONNECTOR_REFS_MAX),
    }),
    responses: {
      200: z.object({
        refreshes: z.array(
          z.object({
            // TODO(#23619): Keep the response aligned with the request rollout.
            connectorRef: connectorSlugSchema,
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

export const runnersBuiltinFirewallsResolveContract = c.router({
  resolve: {
    method: "POST",
    path: "/api/runners/builtin-firewalls/resolve",
    headers: authHeadersSchema,
    body: runnerBuiltinFirewallsResolveBodySchema,
    responses: {
      200: runnerBuiltinFirewallsResolveResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve builtin firewall definitions for runners",
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
    snapshotGeneration: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    snapshotSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    totalVcpu: z.number().int().nonnegative(),
    totalMemoryMb: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().nonnegative(),
    allocatedVcpu: z.number().int().nonnegative(),
    allocatedMemoryMb: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    admittableProfiles: runnerProfileListSchema,
    heldSessionStates: z.array(heldSessionStateSchema).max(1024),
    mode: z.enum(["starting", "running", "draining", "stopping"]),
  })
  .superRefine((heartbeat, ctx) => {
    const workspaceCacheCount = heartbeat.heldSessionStates.reduce(
      (count, state) => {
        return count + (state.workspaceCaches?.length ?? 0);
      },
      0,
    );
    if (workspaceCacheCount <= 1024) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["heldSessionStates"],
      message: "heldSessionStates may contain at most 1024 workspace caches",
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
export type RunnersBuiltinFirewallsResolveContract =
  typeof runnersBuiltinFirewallsResolveContract;
export type Job = z.infer<typeof jobSchema>;
export type HeldSessionState = z.infer<typeof heldSessionStateSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type StoredExecutionContext = z.infer<
  typeof storedExecutionContextSchema
>;
export type CompatibleStoredExecutionContext = z.infer<
  typeof compatibleStoredExecutionContextSchema
>;
export type StoredConnectorPermissionBaseline = z.infer<
  typeof storedConnectorPermissionBaselineSchema
>;
export type NetworkPolicyRefresh = z.infer<typeof networkPolicyRefreshSchema>;
export type RunnerBuiltinFirewallsResolveBody = z.infer<
  typeof runnerBuiltinFirewallsResolveBodySchema
>;
export type RunnerBuiltinFirewallsResolveResponse = z.infer<
  typeof runnerBuiltinFirewallsResolveResponseSchema
>;
export type SecretConnectorMetadata = z.infer<
  typeof secretConnectorMetadataSchema
>;
export type StorageMountEntry = z.infer<typeof storageMountEntrySchema>;
export type StoredStorageMountEntry = z.infer<
  typeof storedStorageMountEntrySchema
>;
export type StorageManifest = z.infer<typeof storageManifestSchema>;
export type CanonicalStorageManifest = StorageManifest;
export type StoredResumeSession = z.infer<typeof storedResumeSessionSchema>;
export type ResumeSession = z.infer<typeof resumeSessionSchema>;
export type SessionHistoryDownloadSource = z.infer<
  typeof sessionHistoryDownloadSourceSchema
>;
export type SessionHistorySizeBucket = z.infer<
  typeof sessionHistorySizeBucketSchema
>;
export type SessionAffinityResource = z.infer<
  typeof sessionAffinityResourceSchema
>;

export type RunnerClaimCapability = z.infer<typeof runnerClaimCapabilitySchema>;
