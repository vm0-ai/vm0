import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { firewallsSchema } from "./firewalls";
import { apiErrorSchema } from "./errors";

const c = initContract();

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
  mountPath: z.string(),
  archiveUrl: z.string().nullable(),
});

/**
 * Artifact entry in manifest
 */
export const artifactEntrySchema = z.object({
  mountPath: z.string(),
  archiveUrl: z.string().nullable(),
  vasStorageName: z.string(),
  vasVersionId: z.string(),
});

/**
 * Storage manifest with presigned URLs for download
 */
export const storageManifestSchema = z.object({
  storages: z.array(storageEntrySchema),
  artifact: artifactEntrySchema.nullable(),
  memory: artifactEntrySchema.nullable(),
});

/**
 * Resume session information
 */
export const resumeSessionSchema = z.object({
  sessionId: z.string(),
  sessionHistory: z.string(),
});

/**
 * Stored execution context (subset stored in database for late routing)
 * Contains prepared context without runtime-generated fields
 * Secrets are encrypted with AES-256-GCM before storage
 */
export const storedExecutionContextSchema = z.object({
  workingDir: z.string(),
  storageManifest: storageManifestSchema.nullable(),
  environment: z.record(z.string(), z.string()).nullable(),
  resumeSession: resumeSessionSchema.nullable(),
  encryptedSecrets: z.string().nullable(), // AES-256-GCM encrypted Record<string, string> (secret name → value)
  // Maps secret names to OAuth connector types for runtime token refresh (e.g. { "GMAIL_ACCESS_TOKEN": "gmail" })
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  cliAgentType: z.string(),
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: z.boolean().optional(),
  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics
  apiStartTime: z.number().optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
  // Memory storage name (for first-run when manifest.memory is null)
  memoryName: z.string().optional(),
  // Firewall for proxy-side token replacement
  firewalls: firewallsSchema.optional(),
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: z.array(z.string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: z.array(z.string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: z.string().optional(),
  // VM profile for resource allocation (e.g., "vm0/default")
  experimentalProfile: z.string().optional(),
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
  // New fields for E2B parity:
  workingDir: z.string(),
  storageManifest: storageManifestSchema.nullable(),
  environment: z.record(z.string(), z.string()).nullable(),
  resumeSession: resumeSessionSchema.nullable(),
  secretValues: z.array(z.string()).nullable(),
  // AES-256-GCM encrypted Record<string, string> — passed through to mitm-addon for auth resolution
  encryptedSecrets: z.string().nullable(),
  // Maps secret names to OAuth connector types for runtime token refresh
  secretConnectorMap: z.record(z.string(), z.string()).nullable().optional(),
  cliAgentType: z.string(),
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: z.boolean().optional(),
  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies: z.boolean().optional(),
  // Dispatch timestamp for E2E timing metrics
  apiStartTime: z.number().optional(),
  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  userTimezone: z.string().optional(),
  // Memory storage name (for first-run when manifest.memory is null)
  memoryName: z.string().optional(),
  // Firewall for proxy-side token replacement
  firewalls: firewallsSchema.optional(),
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: z.array(z.string()).optional(),
  // Tools to make available in Claude CLI (passed as --tools)
  tools: z.array(z.string()).optional(),
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: z.string().optional(),
  // VM profile for resource allocation (e.g., "vm0/default")
  experimentalProfile: z.string().optional(),
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
  heldSessions: z.array(z.string()),
  mode: z.enum(["running", "draining"]),
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
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type StoredExecutionContext = z.infer<
  typeof storedExecutionContextSchema
>;
export type StorageEntry = z.infer<typeof storageEntrySchema>;
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>;
export type StorageManifest = z.infer<typeof storageManifestSchema>;
export type ResumeSession = z.infer<typeof resumeSessionSchema>;
