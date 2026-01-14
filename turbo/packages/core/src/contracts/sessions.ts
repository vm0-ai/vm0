import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Session response schema
 * Represents a persistent running context across multiple runs
 */
const sessionResponseSchema = z.object({
  id: z.string(),
  agentComposeId: z.string(),
  agentComposeVersionId: z.string().nullable(),
  conversationId: z.string().nullable(),
  artifactName: z.string().nullable(),
  vars: z.record(z.string(), z.string()).nullable(),
  secretNames: z.array(z.string()).nullable(),
  volumeVersions: z.record(z.string(), z.string()).nullable(),
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
 * Checkpoint response schema
 * Represents an immutable snapshot of agent run state
 */
const checkpointResponseSchema = z.object({
  id: z.string(),
  runId: z.string(),
  conversationId: z.string(),
  agentComposeSnapshot: agentComposeSnapshotSchema,
  artifactSnapshot: artifactSnapshotSchema.nullable(),
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
  artifactSnapshotSchema,
  volumeVersionsSnapshotSchema,
};

// Export inferred types for consumers
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type CheckpointResponse = z.infer<typeof checkpointResponseSchema>;
export type AgentComposeSnapshot = z.infer<typeof agentComposeSnapshotSchema>;
export type ArtifactSnapshot = z.infer<typeof artifactSnapshotSchema>;
export type VolumeVersionsSnapshot = z.infer<
  typeof volumeVersionsSnapshotSchema
>;
