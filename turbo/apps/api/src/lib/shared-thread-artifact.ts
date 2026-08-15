const SHARED_THREAD_ARTIFACT_AUTHOR_PREFIX = "shared-thread-artifact:";

export const SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX = "shared-thread:";

/**
 * Shared-thread snapshots are stored as the previous API's known `file` kind,
 * but under an owner namespace that its exact-owner catalog query cannot see.
 * The new API projects these compatibility rows back to `shared-thread`.
 */
export function sharedThreadArtifactAuthorUserId(userId: string): string {
  return `${SHARED_THREAD_ARTIFACT_AUTHOR_PREFIX}${userId}`;
}

export function sharedThreadArtifactLogicalKey(id: string): string {
  return `${SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX}${id}`;
}

export function isSharedThreadArtifactLogicalKey(logicalKey: string): boolean {
  return logicalKey.startsWith(SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX);
}
