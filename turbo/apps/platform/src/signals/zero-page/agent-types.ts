export interface AgentDetail {
  agentId: string;
  description: string | null;
  displayName: string | null;
  sound: string | null;
  avatarUrl: string | null;
  connectors: string[];
}

export interface AgentInstructions {
  content: string | null;
  filename: string | null;
}
