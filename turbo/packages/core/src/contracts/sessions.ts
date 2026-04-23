import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Session response schema
 * Represents a persistent running context across multiple runs
 */
const sessionResponseSchema = z.object({
  id: z.string(),
  agentComposeId: z.string(),
  conversationId: z.string().nullable(),
  artifactNames: z.array(z.string()),
  secretNames: z.array(z.string()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Agent compose snapshot schema (stored in checkpoints)
 */
const agentComposeSnapshotSchema = z.object({
  agentComposeVersionId: z.string(),
  vars: z.record(z.string(), z.string()).optional(),
  secretNames: z.array(z.string()).optional(),
});

/**
 * Volume versions snapshot schema
 */
const volumeVersionsSnapshotSchema = z.object({
  versions: z.record(z.string(), z.string()),
});

/**
 * Artifact snapshots schema.
 *
 * Tolerant union accepting both the legacy `Record<name, version>` map
 * (pre-#10911 guest-agent payloads) and the canonical `Array<{name, version,
 * mountPath}>` form (post-#10911). The GET-by-id handler echoes whatever shape
 * is stored in the JSONB column; CLI consumers tolerate both via the union.
 */
const artifactSnapshotsSchema = z.union([
  z.record(z.string(), z.string()),
  z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      mountPath: z.string(),
    }),
  ),
]);

/**
 * Checkpoint response schema
 * Represents an immutable snapshot of agent run state
 */
const checkpointResponseSchema = z.object({
  id: z.string(),
  runId: z.string(),
  conversationId: z.string(),
  agentComposeSnapshot: agentComposeSnapshotSchema,
  // Multi-artifact snapshot payload. Accepts both the legacy
  // `Record<name, version>` map and the canonical
  // `Array<{name, version, mountPath}>` form. Null when the checkpoint has
  // no artifacts.
  artifactSnapshots: artifactSnapshotsSchema.nullable(),
  volumeVersionsSnapshot: volumeVersionsSnapshotSchema.nullable(),
  createdAt: z.string(),
});

/**
 * Sessions by ID route contract (/api/agent/sessions/[id])
 */
export const sessionsByIdContract = c.router({
  /**
   * GET /api/agent/sessions/:id
   * Get session by ID
   */
  getById: {
    method: "GET",
    path: "/api/agent/sessions/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Session ID is required"),
    }),
    responses: {
      200: sessionResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get session by ID",
  },
});

/**
 * Checkpoints by ID route contract (/api/agent/checkpoints/[id])
 */
export const checkpointsByIdContract = c.router({
  /**
   * GET /api/agent/checkpoints/:id
   * Get checkpoint by ID
   */
  getById: {
    method: "GET",
    path: "/api/agent/checkpoints/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Checkpoint ID is required"),
    }),
    responses: {
      200: checkpointResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get checkpoint by ID",
  },
});

export type SessionsByIdContract = typeof sessionsByIdContract;
export type CheckpointsByIdContract = typeof checkpointsByIdContract;

// Export schemas for reuse
export {
  sessionResponseSchema,
  checkpointResponseSchema,
  agentComposeSnapshotSchema,
  volumeVersionsSnapshotSchema,
};

// Export inferred types for consumers
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type CheckpointResponse = z.infer<typeof checkpointResponseSchema>;
export type AgentComposeSnapshot = z.infer<typeof agentComposeSnapshotSchema>;
export type VolumeVersionsSnapshot = z.infer<
  typeof volumeVersionsSnapshotSchema
>;
