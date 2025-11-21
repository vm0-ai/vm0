/**
 * E2B service types
 */

export interface CreateRunOptions {
  agentConfigId: string;
  prompt: string;
  dynamicVars?: Record<string, string>;
  sandboxToken: string; // Temporary bearer token for sandbox to call APIs
  agentConfig?: unknown; // Full agent config JSONB for volume resolution
  apiUrl?: string; // Override API URL (auto-detected from request or from env)
  userId?: string; // User ID for token decryption (optional for backwards compatibility)
  checkpointId?: string; // Optional checkpoint ID to resume from
}

export interface RunResult {
  runId: string;
  sandboxId: string;
  status: "completed" | "failed";
  output: string;
  error?: string;
  executionTimeMs: number;
  createdAt: Date;
  completedAt?: Date;
  volumeMetadata?: VolumeMetadata[];
}

export interface VolumeMetadata {
  volumeName: string;
  driver: string;
  commitSha?: string;
  branch?: string;
  repo?: string;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}
