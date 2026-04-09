import type { FirewallPolicies } from "@vm0/core";

export interface AgentDetail {
  agentId: string;
  ownerId: string;
  description: string | null;
  displayName: string | null;
  sound: string | null;
  avatarUrl: string | null;
  permissionPolicies: FirewallPolicies | null;
  allowUnknownEndpoints: Record<string, boolean> | null;
}

export interface AgentInstructions {
  content: string | null;
  filename: string | null;
}
