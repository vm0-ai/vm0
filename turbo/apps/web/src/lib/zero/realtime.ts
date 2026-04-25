import { and, eq } from "drizzle-orm";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { publishUserSignal } from "../infra/realtime/client";

/**
 * Publish an invalidation signal to every member of an org.
 *
 * Fans out via `publishUserSignal` on each member's user channel, reading
 * membership from the `org_members_cache` table (populated by Clerk sync).
 * Used for org-wide observability signals like queue changes.
 */
export async function publishOrgSignal(
  orgId: string,
  topic: string,
  payload: unknown = null,
): Promise<void> {
  const rows = await globalThis.services.db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(eq(orgMembersCache.orgId, orgId));

  const userIds = rows.map((r) => {
    return r.userId;
  });
  if (userIds.length === 0) {
    return;
  }

  await publishUserSignal(userIds, topic, payload);
}

/**
 * Publish an invalidation signal to every admin of an org.
 *
 * Variant of `publishOrgSignal` that restricts the fan-out to members whose
 * cached role is `admin`. Used for admin-only signals like Slack workspace
 * connect/disconnect which only admins can act on.
 */
export async function publishOrgAdminSignal(
  orgId: string,
  topic: string,
  payload: unknown = null,
): Promise<void> {
  const rows = await globalThis.services.db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.role, "admin")),
    );

  const userIds = rows.map((r) => {
    return r.userId;
  });
  if (userIds.length === 0) {
    return;
  }

  await publishUserSignal(userIds, topic, payload);
}
