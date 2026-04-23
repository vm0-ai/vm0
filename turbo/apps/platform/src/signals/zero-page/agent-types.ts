import type { FirewallPolicies } from "@vm0/core/contracts/firewalls";

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
}

export interface AgentInstructions {
  content: string | null;
  filename: string | null;
}
