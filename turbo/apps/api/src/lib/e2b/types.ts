/**
 * E2B service types
 */

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
