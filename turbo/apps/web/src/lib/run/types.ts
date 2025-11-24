import type { VolumeSnapshot } from "../checkpoint/types";

/**
 * Session history restoration data
 */
export interface ResumeSession {
  sessionId: string;
  sessionHistory: string; // JSONL content
  workingDir: string; // Working directory for session path calculation
}

/**
 * Unified execution context for both new runs and resumed runs
 * This abstraction allows e2b-service to be agnostic about run type
 */
export interface ExecutionContext {
  runId: string;
  userId?: string;
  agentConfigId: string;
  agentConfig: unknown;
  prompt: string;
  dynamicVars?: Record<string, string>;
  sandboxToken: string;

  // Resume-specific (optional)
  resumeSession?: ResumeSession;
  resumeVolumes?: VolumeSnapshot[];
}
