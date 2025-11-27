/**
 * Agent Session types
 * VM0's concept of a persistent running context across multiple runs
 */

/**
 * Agent session data from database
 */
export interface AgentSessionData {
  id: string;
  userId: string;
  agentConfigId: string;
  conversationId: string | null;
  artifactName: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating a new agent session
 */
export interface CreateAgentSessionInput {
  userId: string;
  agentConfigId: string;
  artifactName: string;
  conversationId?: string;
}

/**
 * Input for updating an existing agent session
 */
export interface UpdateAgentSessionInput {
  conversationId: string;
}

/**
 * Agent session with related data for continue operations
 */
export interface AgentSessionWithConversation extends AgentSessionData {
  conversation: {
    id: string;
    cliAgentType: string;
    cliAgentSessionId: string;
    cliAgentSessionHistory: string;
  } | null;
}
