export interface AgentDetail {
  // Mirrors the bounded AgentResponse compatibility in #33251.
  isDefaultAgent?: boolean;
  agentId: string;
  ownerId: string;
  description: string | null;
  displayName: string | null;
  sound: string | null;
  avatarUrl: string | null;
  modelProviderId: string | null;
  selectedModel: string | null;
  preferPersonalProvider: boolean;
  visibility?: "public" | "private";
}

export interface AgentInstructions {
  content: string | null;
  filename: string | null;
}
