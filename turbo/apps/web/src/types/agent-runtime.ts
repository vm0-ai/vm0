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
  status: "completed" | "failed";
  sandboxId: string;
  output: string;
  error?: string;
  executionTimeMs: number;
  createdAt: string;
}
