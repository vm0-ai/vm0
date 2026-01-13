/**
 * E2B service types
 */

export interface CreateRunOptions {
  agentComposeId: string;
  prompt: string;
  vars?: Record<string, string>;
  sandboxToken: string; // Temporary bearer token for sandbox to call APIs
  agentCompose?: unknown; // Full agent compose JSONB for volume resolution
  apiUrl?: string; // Override API URL (auto-detected from request or from env)
}

export interface RunResult {
  runId: string;
  sandboxId: string;
  status: "running" | "completed" | "failed";
  output: string;
  error?: string;
  executionTimeMs: number;
  createdAt: Date;
  completedAt?: Date;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}
