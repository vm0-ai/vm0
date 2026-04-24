import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { logger } from "../shared/logger";
import { orgRoleSchema, type OrgRole } from "@vm0/core/contracts/org-members";

const log = logger("org:membership-cache");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get a user's org role via org_members_cache with Clerk API fallback.
 *
 * Returns { role } if the user is a member, null if not.
 * Cache hit: ~1ms (DB read). Cache miss: ~50-200ms (Clerk API + cache write).
 */
export async function getMemberRole(
  orgId: string,
  userId: string,
): Promise<{ role: OrgRole } | null> {
  // 1. Check cache
  const [cached] = await globalThis.services.db
    .select({ role: orgMembersCache.role, cachedAt: orgMembersCache.cachedAt })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return { role: orgRoleSchema.parse(cached.role) };
  }

  // 2. Cache miss/stale → Clerk API
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId,
    limit: 100,
  });
  const membership = memberships.data.find((m) => {
    return m.organization.id === orgId;
  });

  if (!membership) {
    // Not a member — delete stale cache entry if exists
    if (cached) {
      void globalThis.services.db
        .delete(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, orgId),
            eq(orgMembersCache.userId, userId),
          ),
        )
        .catch((err: unknown) => {
          log.warn("Failed to delete stale org_members_cache entry", { err });
        });
    }
    return null;
  }

  // 3. Update cache (fire-and-forget)
  const role: OrgRole = membership.role === "org:admin" ? "admin" : "member";
  const now = new Date();
  void globalThis.services.db
    .insert(orgMembersCache)
    .values({ orgId, userId, role, cachedAt: now })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role, cachedAt: now },
    })
    .catch((err: unknown) => {
      log.warn("Failed to update org_members_cache", { err });
    });

  return { role };
}
