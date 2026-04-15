import type { AdditionalVolume } from "../../storage/types";

/**
 * Intermediate resolution result from checkpoint/session/conversation expansion
 * Contains all data needed to build resumeSession uniformly
 * Note: Environment is re-expanded server-side from compose + vars/secrets, not stored in checkpoint
 * Note: Secrets values are NEVER stored - only names for validation. Fresh secrets must be provided at runtime.
 */
export interface ConversationResolution {
  conversationId: string;
  agentComposeVersionId: string;
  agentCompose: unknown;
  workingDir: string;
  conversationData: {
    cliAgentSessionId: string;
    cliAgentSessionHistory: string;
  };
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  vars?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  additionalVolumes?: AdditionalVolume[];
  buildResumeArtifact: boolean;
  /** Run ID from the previous conversation (used by zero layer for provider compatibility) */
  previousRunId?: string;
}
