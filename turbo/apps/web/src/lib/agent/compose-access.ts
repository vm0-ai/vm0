import { eq, and } from "drizzle-orm";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { logger } from "../logger";

const log = logger("agent:compose-access");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Check if a user can access an agent compose.
 *
 * Access is granted if:
 * 1. User is the owner of the compose
 * 2. User is a member of the same Clerk organization
 */
export async function canAccessCompose(
  userId: string,
  _userEmail: string,
  compose: { id: string; userId: string; orgId: string },
): Promise<boolean> {
  // 1. Owner always has access
  if (compose.userId === userId) return true;

  // 2. Check org membership via Clerk
  const authResult = await auth();

  // JWT fast path: active org matches → trust JWT, no API call
  if (authResult.orgId === compose.orgId) {
    return true;
  }

  // Cache-backed Clerk API fallback for cross-org or non-session contexts
  if (!compose.orgId.startsWith("pending_")) {
    // Check org_members_cache first (DB read, no Clerk API call)
    const [cached] = await globalThis.services.db
      .select({ cachedAt: orgMembersCache.cachedAt })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, compose.orgId),
          eq(orgMembersCache.userId, userId),
        ),
      )
      .limit(1);

    if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
      return true;
    }

    // Cache miss or stale — call Clerk API and update cache
    const client = await clerkClient();
    const memberships = await client.users.getOrganizationMembershipList({
      userId,
      limit: 100,
    });
    const isMember = memberships.data.some(
      (m) => m.organization.id === compose.orgId,
    );
    if (isMember) {
      // Fire-and-forget: cache write is non-critical, don't block access
      const now = new Date();
      void globalThis.services.db
        .insert(orgMembersCache)
        .values({
          orgId: compose.orgId,
          userId,
          cachedAt: now,
        })
        .onConflictDoUpdate({
          target: [orgMembersCache.orgId, orgMembersCache.userId],
          set: { cachedAt: now },
        })
        .catch((err: unknown) => {
          log.warn("Failed to update org_members_cache", { err });
        });
      return true;
    }
  }

  return false;
}
