import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";

/**
 * Insert an org_members_cache entry for testing cache behavior.
 */
export async function insertOrgMembersCacheEntry(entry: {
  orgId: string;
  userId: string;
  role?: string;
  cachedAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgMembersCache)
    .values({
      orgId: entry.orgId,
      userId: entry.userId,
      role: entry.role ?? "member",
      cachedAt: entry.cachedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        role: entry.role ?? "member",
        cachedAt: entry.cachedAt ?? new Date(),
      },
    });
}

/**
 * Find a cached membership entry by (orgId, userId).
 */
export async function findOrgMembersCacheEntry(orgId: string, userId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);
  return row;
}

/**
 * Delete a cached membership entry. Useful for tests that need to change
 * a user's role mid-test (the cache would otherwise serve the stale role).
 */
export async function clearOrgMembersCacheEntry(
  orgId: string,
  userId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    );
}
