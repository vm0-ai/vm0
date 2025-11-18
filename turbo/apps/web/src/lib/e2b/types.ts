/**
 * E2B service types
 */

export interface CreateRuntimeOptions {
  agentConfigId: string;
  prompt: string;
  dynamicVars?: Record<string, string>;
  sandboxToken: string; // Temporary bearer token for sandbox to call APIs
}

export interface RuntimeResult {
  runtimeId: string;
  sandboxId: string;
  status: "completed" | "failed";
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
