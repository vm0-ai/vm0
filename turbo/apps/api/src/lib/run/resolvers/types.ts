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
  vars?: Record<string, string>;
  /** Secret names required for this run (values must be provided at runtime) */
  secretNames?: string[];
  volumeVersions?: Record<string, string>;
  buildResumeArtifact: boolean;
}
