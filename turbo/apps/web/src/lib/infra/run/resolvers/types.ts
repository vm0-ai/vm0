import type { AdditionalVolume } from "../../storage/types";
import type { ContextArtifact } from "../types";

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
  /**
   * Unified artifact list with explicit mountPath per entry.
   * Resume-from-session emits entries with version "latest"; resume-from-checkpoint
   * emits concrete version IDs from checkpoints.artifactSnapshots.
   */
  artifacts: ContextArtifact[];
  vars?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  additionalVolumes?: AdditionalVolume[];
  /** Run ID from the previous conversation (used by zero layer for provider compatibility) */
  previousRunId?: string;
  /**
   * Framework recorded on the conversation being continued
   * (`conversations.cliAgentType`). Source of truth for the previous run's
   * framework — compared against the resolved execution context framework to
   * detect mid-thread framework switches. Undefined for direct-conversation
   * resumes from data that predates cliAgentType persistence.
   */
  sessionFramework: string | undefined;
}
