/**
 * Executor Types
 *
 * Shared interfaces and types for the job executor.
 */

/**
 * Execution result
 */
export interface ExecutionResult {
  exitCode: number;
  error?: string;
}

/**
 * Execution options for customizing job execution behavior
 */
export interface ExecutionOptions {
  /**
   * Benchmark mode for local VM performance testing without API server:
   * - Runs prompt directly as bash command (skips run-agent.py)
   * - Skips network log upload
   * - Skips telemetry reporting
   * Used by the benchmark command
   */
  benchmarkMode?: boolean;
}
