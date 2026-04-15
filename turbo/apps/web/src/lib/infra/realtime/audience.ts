import "server-only";
import { eq } from "drizzle-orm";
import { orgMembersCache } from "../../../db/schema/org-members-cache";

/**
 * Get all user IDs that are members of the given organization.
 * Queries the org_members_cache table which is kept in sync with Clerk.
 */
export async function getOrgMemberUserIds(orgId: string): Promise<string[]> {
  const rows = await globalThis.services.db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(eq(orgMembersCache.orgId, orgId));

  return rows.map((r) => {
    return r.userId;
  });
}
