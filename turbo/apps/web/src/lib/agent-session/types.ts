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
  agentComposeId: string;
  conversationId: string | null;
  artifactName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating a new agent session
 */
export interface CreateAgentSessionInput {
  userId: string;
  agentComposeId: string;
  artifactName?: string;
  conversationId?: string;
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
