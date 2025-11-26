/**
 * Agent run types
 */

export interface CreateAgentRunRequest {
  agentConfigId: string;
  prompt: string;
  dynamicVars?: Record<string, string>;
  artifactKey?: string; // Artifact key for VM0 driver artifacts
}

export interface CreateAgentRunResponse {
  runId: string;
  status: "pending" | "running" | "completed" | "failed";
  sandboxId?: string;
  output?: string;
  error?: string;
  executionTimeMs?: number;
  createdAt: string;
}

export interface GetAgentRunResponse {
  runId: string;
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
