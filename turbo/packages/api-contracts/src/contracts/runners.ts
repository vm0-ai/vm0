import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  firewallsSchema,
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
});

export const heldSessionStateSchema = z.object({
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
    body: z.object({
      group: runnerGroupSchema,
      profiles: z.array(z.string()).optional(),
      heldSessionStates: z.array(heldSessionStateSchema).max(1024).optional(),
    }),
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
  manifestUrl: z.string().optional(),
  missingRootPolicy: artifactMissingRootPolicySchema.optional(),
});

/**
 * Storage manifest with presigned URLs for download
 */
export const storageManifestSchema = z.object({
  storages: z.array(storageEntrySchema),
  artifacts: z.array(artifactEntrySchema),
});

export const storageProvisioningIntentSchema = z.enum([
  "user-volume",
  "user-artifact",
  "instructions",
  "skill",
  "memory",
]);

export const storageProvisioningSourceKindSchema = z.enum([
  "storage",
  "artifact",
]);

export const storageProvisioningFrameworkSchema = z.enum([
  "claude-code",
  "codex",
]);

export const storageProvisioningDestinationTypeSchema = z.enum([
  "workspace",
  "mnt",
  "framework-instructions",
  "framework-skill",
  "framework-memory",
]);

export const storageProvisioningSourceSchema = z.object({
  kind: storageProvisioningSourceKindSchema,
  name: z.string().min(1),
  vasStorageName: z.string().min(1),
  vasStorageId: z.string().min(1).optional(),
  vasVersionId: z.string().min(1),
  archiveUrl: z.string().min(1),
  manifestUrl: z.string().min(1).optional(),
});

function guestPathSegmentIssue(
  segment: string,
  label: string,
): string | undefined {
  if (segment === "" || segment === "." || segment === "..") {
    return `${label} cannot contain empty or traversal segments`;
  }
  if (segment.includes("/") || segment.includes("\0")) {
    return `${label} cannot contain slash or NUL bytes`;
  }
  return undefined;
}

function guestRelativeSubPathIssue(path: string): string | undefined {
  if (path === "") {
    return undefined;
  }
  if (path.startsWith("/") || path.includes("\0")) {
    return "destination subPath must be relative";
  }
  for (const segment of path.split("/")) {
    const issue = guestPathSegmentIssue(segment, "destination subPath");
    if (issue) {
      return issue;
    }
  }
  return undefined;
}

type StorageProvisioningDestinationCandidate = {
  readonly type: z.infer<typeof storageProvisioningDestinationTypeSchema>;
  readonly name?: string;
  readonly subPath?: string;
  readonly framework?: z.infer<typeof storageProvisioningFrameworkSchema>;
  readonly skillName?: string;
};

type DestinationIssueAdder = (message: string, path: string[]) => void;

function addDestinationSubPathIssue(
  subPath: string | undefined,
  addIssue: DestinationIssueAdder,
): void {
  const issue =
    subPath !== undefined ? guestRelativeSubPathIssue(subPath) : undefined;
  if (issue) {
    addIssue(issue, ["subPath"]);
  }
}

function validateWorkspaceProvisioningDestination(
  destination: StorageProvisioningDestinationCandidate,
  addIssue: DestinationIssueAdder,
): void {
  if (destination.name !== undefined) {
    addIssue("workspace destinations cannot include name", ["name"]);
  }
  if (destination.framework !== undefined) {
    addIssue("workspace destinations cannot include framework", ["framework"]);
  }
  if (destination.skillName !== undefined) {
    addIssue("workspace destinations cannot include skillName", ["skillName"]);
  }
  addDestinationSubPathIssue(destination.subPath, addIssue);
}

function validateMntProvisioningDestination(
  destination: StorageProvisioningDestinationCandidate,
  addIssue: DestinationIssueAdder,
): void {
  if (destination.name === undefined) {
    addIssue("mnt destinations require name", ["name"]);
  } else {
    const issue = guestPathSegmentIssue(
      destination.name,
      "mnt destination name",
    );
    if (issue) {
      addIssue(issue, ["name"]);
    }
  }
  if (destination.framework !== undefined) {
    addIssue("mnt destinations cannot include framework", ["framework"]);
  }
  if (destination.skillName !== undefined) {
    addIssue("mnt destinations cannot include skillName", ["skillName"]);
  }
  addDestinationSubPathIssue(destination.subPath, addIssue);
}

function validateFrameworkProvisioningDestination(
  destination: StorageProvisioningDestinationCandidate,
  addIssue: DestinationIssueAdder,
): void {
  if (destination.framework === undefined) {
    addIssue(`${destination.type} destinations require framework`, [
      "framework",
    ]);
  }
  if (destination.name !== undefined) {
    addIssue(`${destination.type} destinations cannot include name`, ["name"]);
  }
  if (destination.subPath !== undefined) {
    addIssue(`${destination.type} destinations cannot include subPath`, [
      "subPath",
    ]);
  }

  if (destination.type === "framework-skill") {
    if (destination.skillName === undefined) {
      addIssue("framework-skill destinations require skillName", ["skillName"]);
    } else {
      const issue = guestPathSegmentIssue(
        destination.skillName,
        "framework skill name",
      );
      if (issue) {
        addIssue(issue, ["skillName"]);
      }
    }
    return;
  }

  if (destination.skillName !== undefined) {
    addIssue(`${destination.type} destinations cannot include skillName`, [
      "skillName",
    ]);
  }
}

function optionalSubPathMountPath(
  basePath: string,
  subPath: string | undefined,
): string | undefined {
  if (guestRelativeSubPathIssue(subPath ?? "") !== undefined) {
    return undefined;
  }
  return subPath ? `${basePath}/${subPath}` : basePath;
}

function frameworkHomeDir(
  framework: StorageProvisioningDestinationCandidate["framework"],
): string | undefined {
  if (framework === "codex") {
    return `${CANONICAL_GUEST_HOME_DIR}/.codex`;
  }
  if (framework === "claude-code") {
    return `${CANONICAL_GUEST_HOME_DIR}/.claude`;
  }
  return undefined;
}

function workspaceProvisioningMountPath(
  destination: StorageProvisioningDestinationCandidate,
): string | undefined {
  if (
    destination.name !== undefined ||
    destination.framework !== undefined ||
    destination.skillName !== undefined
  ) {
    return undefined;
  }
  return optionalSubPathMountPath(CANONICAL_WORKING_DIR, destination.subPath);
}

function mntProvisioningMountPath(
  destination: StorageProvisioningDestinationCandidate,
): string | undefined {
  if (
    destination.name === undefined ||
    destination.framework !== undefined ||
    destination.skillName !== undefined ||
    guestPathSegmentIssue(destination.name, "mnt destination name") !==
      undefined
  ) {
    return undefined;
  }
  return optionalSubPathMountPath(
    `/mnt/${destination.name}`,
    destination.subPath,
  );
}

function frameworkInstructionsMountPath(
  destination: StorageProvisioningDestinationCandidate,
): string | undefined {
  if (
    destination.name !== undefined ||
    destination.subPath !== undefined ||
    destination.skillName !== undefined
  ) {
    return undefined;
  }
  return frameworkHomeDir(destination.framework);
}

function frameworkSkillMountPath(
  destination: StorageProvisioningDestinationCandidate,
): string | undefined {
  const frameworkHome = frameworkHomeDir(destination.framework);
  if (
    frameworkHome === undefined ||
    destination.name !== undefined ||
    destination.subPath !== undefined ||
    destination.skillName === undefined ||
    guestPathSegmentIssue(destination.skillName, "framework skill name") !==
      undefined
  ) {
    return undefined;
  }
  return `${frameworkHome}/skills/${destination.skillName}`;
}

function frameworkMemoryMountPath(
  destination: StorageProvisioningDestinationCandidate,
): string | undefined {
  if (
    destination.name !== undefined ||
    destination.subPath !== undefined ||
    destination.skillName !== undefined
  ) {
    return undefined;
  }
  if (destination.framework === "codex") {
    return CANONICAL_CODEX_MEMORY_MOUNT_PATH;
  }
  if (destination.framework === "claude-code") {
    return CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
  }
  return undefined;
}

function provisioningDestinationMountPath(
  destination: StorageProvisioningDestinationCandidate,
): string | undefined {
  switch (destination.type) {
    case "workspace": {
      return workspaceProvisioningMountPath(destination);
    }
    case "mnt": {
      return mntProvisioningMountPath(destination);
    }
    case "framework-instructions": {
      return frameworkInstructionsMountPath(destination);
    }
    case "framework-skill": {
      return frameworkSkillMountPath(destination);
    }
    case "framework-memory": {
      return frameworkMemoryMountPath(destination);
    }
    default: {
      const exhaustive: never = destination.type;
      return exhaustive;
    }
  }
}

export const storageProvisioningDestinationSchema = z
  .object({
    type: storageProvisioningDestinationTypeSchema,
    name: z.string().min(1).optional(),
    subPath: z.string().optional(),
    framework: storageProvisioningFrameworkSchema.optional(),
    skillName: z.string().min(1).optional(),
  })
  .superRefine((destination, ctx) => {
    const addIssue = (message: string, path: string[]): void => {
      ctx.addIssue({
        code: "custom",
        message,
        path,
      });
    };

    if (destination.type === "workspace") {
      validateWorkspaceProvisioningDestination(destination, addIssue);
      return;
    }

    if (destination.type === "mnt") {
      validateMntProvisioningDestination(destination, addIssue);
      return;
    }

    validateFrameworkProvisioningDestination(destination, addIssue);
  });

export const storageProvisioningEntrySchema = z
  .object({
    intent: storageProvisioningIntentSchema,
    source: storageProvisioningSourceSchema,
    destination: storageProvisioningDestinationSchema,
    instructionsTargetFilename: z.string().min(1).optional(),
    missingRootPolicy: artifactMissingRootPolicySchema.optional(),
  })
  .superRefine((entry, ctx) => {
    const sourceKindByIntent = {
      "user-volume": "storage",
      "user-artifact": "artifact",
      instructions: "storage",
      skill: "storage",
      memory: "artifact",
    } as const satisfies Record<
      z.infer<typeof storageProvisioningIntentSchema>,
      z.infer<typeof storageProvisioningSourceKindSchema>
    >;
    const destinationTypesByIntent = {
      "user-volume": ["workspace", "mnt"],
      "user-artifact": ["workspace", "mnt"],
      instructions: ["framework-instructions"],
      skill: ["framework-skill"],
      memory: ["framework-memory"],
    } as const satisfies Record<
      z.infer<typeof storageProvisioningIntentSchema>,
      readonly z.infer<typeof storageProvisioningDestinationTypeSchema>[]
    >;

    if (entry.source.kind !== sourceKindByIntent[entry.intent]) {
      ctx.addIssue({
        code: "custom",
        message: `${entry.intent} entries require ${sourceKindByIntent[entry.intent]} sources`,
        path: ["source", "kind"],
      });
    }
    const allowedDestinationTypes = destinationTypesByIntent[
      entry.intent
    ] as readonly z.infer<typeof storageProvisioningDestinationTypeSchema>[];
    if (!allowedDestinationTypes.includes(entry.destination.type)) {
      ctx.addIssue({
        code: "custom",
        message: `${entry.intent} entries require ${allowedDestinationTypes.join(
          " or ",
        )} destinations`,
        path: ["destination", "type"],
      });
    }

    if (
      entry.source.kind === "artifact" &&
      entry.source.vasStorageId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "artifact sources require vasStorageId",
        path: ["source", "vasStorageId"],
      });
    }

    if (
      entry.instructionsTargetFilename !== undefined &&
      entry.intent !== "instructions"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "instructionsTargetFilename is only valid for instructions",
        path: ["instructionsTargetFilename"],
      });
    }
    if (
      entry.intent === "instructions" &&
      entry.instructionsTargetFilename === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "instructions entries require instructionsTargetFilename",
        path: ["instructionsTargetFilename"],
      });
    }
    if (
      entry.instructionsTargetFilename !== undefined &&
      entry.instructionsTargetFilename !== "CLAUDE.md" &&
      entry.instructionsTargetFilename !== "AGENTS.md"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "instructionsTargetFilename must be CLAUDE.md or AGENTS.md",
        path: ["instructionsTargetFilename"],
      });
    }

    if (
      entry.missingRootPolicy !== undefined &&
      entry.source.kind !== "artifact"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "missingRootPolicy is only valid for artifacts",
        path: ["missingRootPolicy"],
      });
    }
  });

export const storageProvisioningManifestSchema = z
  .object({
    version: z.literal("2"),
    entries: z.array(storageProvisioningEntrySchema),
  })
  .superRefine((manifest, ctx) => {
    const seenMountPaths = new Set<string>();
    manifest.entries.forEach((entry, index) => {
      const mountPath = provisioningDestinationMountPath(entry.destination);
      if (mountPath === undefined) {
        return;
      }
      if (seenMountPaths.has(mountPath)) {
        ctx.addIssue({
          code: "custom",
          message: `storage provisioning destinations must be unique: ${mountPath}`,
          path: ["entries", index, "destination"],
        });
        return;
      }
      seenMountPaths.add(mountPath);
    });
  });

/**
 * Resume session information
 */
export const resumeSessionSchema = z.object({
  sessionId: z.string(),
  sessionHistory: z.string(),
});

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
  storageProvisioningManifest: storageProvisioningManifestSchema
    .nullable()
    .optional(),
  environment: z.record(z.string(), z.string()).nullable(),
  resumeSession: resumeSessionSchema.nullable(),
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
  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
  // Firewall for proxy-side token replacement (complete config, all permissions)
  firewalls: firewallsSchema.optional(),
  // Per-firewall network policies: which permissions are granted + unknownPolicy
  networkPolicies: networkPoliciesSchema.optional(),
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
  storageProvisioningManifest: storageProvisioningManifestSchema
    .nullable()
    .optional(),
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
  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics, as Unix epoch milliseconds
  apiStartTime: apiStartTimeSchema.optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
  // Firewall for proxy-side token replacement (complete config, all permissions)
  firewalls: firewallsSchema.optional(),
  // Per-firewall network policies: which permissions are granted + unknownPolicy
  networkPolicies: networkPoliciesSchema.optional(),
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
    body: z.object({}),
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

/**
 * Runner heartbeat body — periodic state report from each runner
 */
export const heartbeatBodySchema = z.object({
  runnerId: z.uuid(),
  runnerName: z.string(),
  group: runnerGroupSchema,
  profiles: z.array(z.string()),
  totalVcpu: z.number().int().nonnegative(),
  totalMemoryMb: z.number().int().nonnegative(),
  maxConcurrent: z.number().int().nonnegative(),
  allocatedVcpu: z.number().int().nonnegative(),
  allocatedMemoryMb: z.number().int().nonnegative(),
  runningCount: z.number().int().nonnegative(),
  heldSessionStates: z.array(heldSessionStateSchema).max(1024),
  mode: z.enum(["running", "draining", "stopping"]),
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
export type RunnersHeartbeatContract = typeof runnersHeartbeatContract;
export type Job = z.infer<typeof jobSchema>;
export type HeldSessionState = z.infer<typeof heldSessionStateSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type StoredExecutionContext = z.infer<
  typeof storedExecutionContextSchema
>;
export type SecretConnectorMetadata = z.infer<
  typeof secretConnectorMetadataSchema
>;
export type StorageEntry = z.infer<typeof storageEntrySchema>;
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>;
export type StorageManifest = z.infer<typeof storageManifestSchema>;
export type StorageProvisioningIntent = z.infer<
  typeof storageProvisioningIntentSchema
>;
export type StorageProvisioningSourceKind = z.infer<
  typeof storageProvisioningSourceKindSchema
>;
export type StorageProvisioningFramework = z.infer<
  typeof storageProvisioningFrameworkSchema
>;
export type StorageProvisioningDestinationType = z.infer<
  typeof storageProvisioningDestinationTypeSchema
>;
export type StorageProvisioningSource = z.infer<
  typeof storageProvisioningSourceSchema
>;
export type StorageProvisioningDestination = z.infer<
  typeof storageProvisioningDestinationSchema
>;
export type StorageProvisioningEntry = z.infer<
  typeof storageProvisioningEntrySchema
>;
export type StorageProvisioningManifest = z.infer<
  typeof storageProvisioningManifestSchema
>;
export type ResumeSession = z.infer<typeof resumeSessionSchema>;
