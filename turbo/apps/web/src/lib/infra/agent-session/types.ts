import type { ContextArtifact } from "../run/types";

/**
 * Agent Session types
 * Lightweight compose ↔ conversation association for continue operations
 * Sessions always use HEAD compose version at runtime — no snapshotting
 */

/**
 * Agent session data from database
 */
export interface AgentSessionData {
  id: string;
  userId: string;
  orgId: string;
  agentComposeId: string;
  conversationId: string | null;
  artifacts: ContextArtifact[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Agent session with related data for continue operations
 */
export interface AgentSessionWithConversation extends AgentSessionData {
  conversation: {
    id: string;
    runId: string;
    cliAgentType: string;
    cliAgentSessionId: string;
    /** @deprecated Legacy TEXT storage - use cliAgentSessionHistoryHash instead */
    cliAgentSessionHistory: string | null;
    /** SHA-256 hash reference to R2 blob storage */
    cliAgentSessionHistoryHash: string | null;
  } | null;
}
