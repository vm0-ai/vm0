export interface AgentDetail {
  name: string;
  agentComposeId: string;
  description: string | null;
  displayName: string | null;
  sound: string | null;
  connectors: string[];
}

export interface AgentInstructions {
  content: string | null;
  filename: string | null;
}
