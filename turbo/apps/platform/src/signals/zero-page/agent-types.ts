import type { FirewallPolicies } from "@vm0/connectors/firewall-types";

export interface AgentDetail {
  agentId: string;
  ownerId: string;
  description: string | null;
  displayName: string | null;
  sound: string | null;
  avatarUrl: string | null;
  permissionPolicies: FirewallPolicies | null;
  modelProviderId: string | null;
  selectedModel: string | null;
  preferPersonalProvider: boolean;
  visibility?: "public" | "private";
}

export interface AgentInstructions {
  content: string | null;
  filename: string | null;
}
