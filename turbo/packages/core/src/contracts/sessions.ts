import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { summaryEntrySchema } from "./chat-threads";

const c = initContract();

/**
 * Stored chat message schema (persisted in agent_sessions.chat_messages JSONB)
 */
const storedChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  runId: z.string().optional(),
  summaries: z.array(summaryEntrySchema).optional(),
  createdAt: z.string(),
});

/**
 * Session response schema
 * Represents a persistent running context across multiple runs
 */
const sessionResponseSchema = z.object({
  id: z.string(),
  agentComposeId: z.string(),
  conversationId: z.string().nullable(),
  artifactName: z.string().nullable(),
  secretNames: z.array(z.string()).nullable(),
  chatMessages: z.array(storedChatMessageSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Session list item schema (lightweight, for listing)
 */
const sessionListItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number(),
  preview: z.string().nullable(),
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
 * Sessions list route contract (/api/agent/sessions)
 */
export const sessionsContract = c.router({
  /**
   * GET /api/agent/sessions?agentComposeId=X
   * List chat sessions for an agent
   */
  list: {
    method: "GET",
    path: "/api/agent/sessions",
    headers: authHeadersSchema,
    query: z.object({
      agentComposeId: z.string().min(1, "agentComposeId is required"),
    }),
    responses: {
      200: z.object({ sessions: z.array(sessionListItemSchema) }),
      401: apiErrorSchema,
    },
    summary: "List chat sessions for an agent",
  },
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
 * Session messages route contract (/api/agent/sessions/[id]/messages)
 */
export const sessionMessagesContract = c.router({
  /**
   * POST /api/agent/sessions/:id/messages
   * Append chat messages to a session
   */
  append: {
    method: "POST",
    path: "/api/agent/sessions/:id/messages",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Session ID is required"),
    }),
    body: z.object({
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
          runId: z.string().optional(),
        }),
      ),
    }),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Append chat messages to a session",
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

export type SessionsContract = typeof sessionsContract;
export type SessionsByIdContract = typeof sessionsByIdContract;
export type SessionMessagesContract = typeof sessionMessagesContract;
export type CheckpointsByIdContract = typeof checkpointsByIdContract;

// Export schemas for reuse
export {
  storedChatMessageSchema,
  sessionResponseSchema,
  sessionListItemSchema,
  checkpointResponseSchema,
  agentComposeSnapshotSchema,
  artifactSnapshotSchema,
  volumeVersionsSnapshotSchema,
};

// Export inferred types for consumers
export type StoredChatMessage = z.infer<typeof storedChatMessageSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type SessionListItem = z.infer<typeof sessionListItemSchema>;
export type CheckpointResponse = z.infer<typeof checkpointResponseSchema>;
export type AgentComposeSnapshot = z.infer<typeof agentComposeSnapshotSchema>;
export type ArtifactSnapshot = z.infer<typeof artifactSnapshotSchema>;
export type VolumeVersionsSnapshot = z.infer<
  typeof volumeVersionsSnapshotSchema
>;
