/**
 * Checkpoint system types for preserving agent run state
 */

/**
 * Artifact snapshot payload shapes the writer may send. Legacy Record is still
 * accepted (pre-#10911 guest-agents) and the canonical array shape carries
 * mountPath per entry (post-#10911). Receiver tolerance lives in
 * `decode-artifact-snapshots.ts`.
 *
 * Note: the array-entry's `version` is always a resolved concrete string —
 * distinct from `ContextArtifact` (execution-context type) where `version` is
 * optional and defaults to "latest".
 */
export type ArtifactSnapshotsPayload =
  | Record<string, string>
  | Array<{ name: string; version: string; mountPath: string }>;

/**
 * Agent compose snapshot stored in checkpoint
 * Uses version ID for reproducibility (content-addressed versioning)
 * Note: Environment is re-expanded from vars/secrets on resume, not stored
 * Note: Secrets values are never persisted - only names for validation
 */
export interface AgentComposeSnapshot {
  agentComposeVersionId: string; // SHA-256 hash of compose content
  vars?: Record<string, string>;
  secretNames?: string[]; // Secret names only (for validation), values never stored
}

/**
 * Volume versions snapshot for checkpoint
 * Stores resolved volume versions at checkpoint time for exact reproducibility
 */
export interface VolumeVersionsSnapshot {
  // Map of volume name to resolved version ID
  versions: Record<string, string>;
  // Additional volumes with resolved versions and mount paths (for checkpoint restore)
  additionalVolumes?: Array<{
    name: string;
    versionId: string;
    mountPath: string;
  }>;
}

/**
 * Request body for checkpoint webhook endpoint
 */
export interface CheckpointRequest {
  runId: string;
  cliAgentType: string;
  cliAgentSessionId: string;
  cliAgentSessionHistoryHash: string;
  // Multi-artifact snapshot payload. Accepts both legacy Record (pre-#10911)
  // and canonical array (post-#10911) shapes; persisted verbatim to the
  // JSONB column. May be empty or missing when the guest snapshotted nothing.
  artifactSnapshots?: ArtifactSnapshotsPayload;
  volumeVersionsSnapshot?: VolumeVersionsSnapshot;
}

/**
 * Response from checkpoint creation.
 *
 * `artifacts` always echoes the canonical Array shape that was persisted
 * to the JSONB column — even when the caller sent a legacy Record payload,
 * the writer normalises before persisting and the response echoes the
 * normalised form. This keeps on-wire and on-disk representations in sync.
 */
export interface CheckpointResponse {
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
  artifacts?: Array<{ name: string; version: string; mountPath: string }>;
  volumes?: Record<string, string>;
}
