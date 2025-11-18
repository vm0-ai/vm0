/**
 * E2B service types
 */

export interface CreateRuntimeOptions {
  agentConfigId: string;
  prompt: string;
  dynamicVars?: Record<string, string>;
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
