import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Firewall rule schema for network egress control
 *
 * Rules can be either:
 * - Domain/IP rule: { domain: "*.example.com", action: "ALLOW" }
 * - Terminal rule: { final: "DENY" }
 */
export const firewallRuleSchema = z.object({
  domain: z.string().optional(),
  ip: z.string().optional(),
  /** Terminal rule - value is the action (ALLOW or DENY) */
  final: z.enum(["ALLOW", "DENY"]).optional(),
  /** Action for domain/ip rules */
  action: z.enum(["ALLOW", "DENY"]).optional(),
});

/**
 * Experimental firewall configuration schema
 */
export const experimentalFirewallSchema = z.object({
  enabled: z.boolean(),
  rules: z.array(firewallRuleSchema).optional(),
  experimental_mitm: z.boolean().optional(),
  experimental_seal_secrets: z.boolean().optional(),
});

/**
 * Runner group format: scope/name (e.g., "acme/production")
 */
export const runnerGroupSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+\/[a-z0-9-]+$/,
    "Runner group must be in scope/name format (e.g., acme/production)",
  );

/**
 * Job schema for polling response
 */
export const jobSchema = z.object({
  runId: z.string().uuid(),
  prompt: z.string(),
  agentComposeVersionId: z.string(),
  vars: z.record(z.string(), z.string()).nullable(),
  secretNames: z.array(z.string()).nullable(),
  checkpointId: z.string().uuid().nullable(),
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
  encryptedSecrets: z.string().nullable(), // AES-256-GCM encrypted secrets
  cliAgentType: z.string(),
  experimentalFirewall: experimentalFirewallSchema.optional(),
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: z.boolean().optional(),
});

/**
 * Execution context returned when claiming a job
 */
export const executionContextSchema = z.object({
  runId: z.string().uuid(),
  prompt: z.string(),
  agentComposeVersionId: z.string(),
  vars: z.record(z.string(), z.string()).nullable(),
  secretNames: z.array(z.string()).nullable(),
  checkpointId: z.string().uuid().nullable(),
  sandboxToken: z.string(),
  // New fields for E2B parity:
  workingDir: z.string(),
  storageManifest: storageManifestSchema.nullable(),
  environment: z.record(z.string(), z.string()).nullable(),
  resumeSession: resumeSessionSchema.nullable(),
  secretValues: z.array(z.string()).nullable(),
  cliAgentType: z.string(),
  // Experimental firewall configuration
  experimentalFirewall: experimentalFirewallSchema.optional(),
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude: z.boolean().optional(),
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
      id: z.string().uuid(),
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

export type RunnersPollContract = typeof runnersPollContract;
export type RunnersJobClaimContract = typeof runnersJobClaimContract;
export type Job = z.infer<typeof jobSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type StoredExecutionContext = z.infer<
  typeof storedExecutionContextSchema
>;
export type StorageEntry = z.infer<typeof storageEntrySchema>;
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>;
export type StorageManifest = z.infer<typeof storageManifestSchema>;
export type ResumeSession = z.infer<typeof resumeSessionSchema>;
export type FirewallRule = z.infer<typeof firewallRuleSchema>;
export type ExperimentalFirewall = z.infer<typeof experimentalFirewallSchema>;
