/**
 * Check if a user can access an agent compose.
 *
 * Access is granted if:
 * 1. The compose belongs to the caller's active org
 * 2. The user is the owner of the compose
 */
export function canAccessCompose(
  userId: string,
  orgId: string,
  compose: { id: string; userId: string; orgId: string },
): boolean {
  if (compose.orgId === orgId) return true;
  if (compose.userId === userId) return true;
  return false;
}
