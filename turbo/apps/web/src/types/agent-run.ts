/**
 * Agent run types
 */

export interface CreateAgentRunRequest {
  agentConfigId: string;
  prompt: string;
  templateVars?: Record<string, string>;
  artifactName: string; // Required: artifact storage name
  artifactVersion?: string; // Optional: version hash (defaults to "latest")
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
  templateVars?: Record<string, string>;
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
