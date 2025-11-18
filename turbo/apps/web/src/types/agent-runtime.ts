/**
 * Agent runtime types
 */

export interface CreateAgentRuntimeRequest {
  agentConfigId: string;
  prompt: string;
  dynamicVars?: Record<string, string>;
}

export interface CreateAgentRuntimeResponse {
  runtimeId: string;
  status: "pending" | "running" | "completed" | "failed";
  sandboxId: string;
  output: string;
  error?: string;
  executionTimeMs: number;
  createdAt: string;
}

export interface GetAgentRuntimeResponse {
  runtimeId: string;
  agentConfigId: string;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  dynamicVars?: Record<string, string>;
  sandboxId?: string;
  result?: {
    output: string;
    executionTimeMs: number;
  };
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
