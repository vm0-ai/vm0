import { and, eq } from "drizzle-orm";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";

import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";

export async function publishFeishuOrgChanged(
  db: Db,
  orgId: string,
  ownerUserId: string | null,
  additionalUserIds: readonly string[] = [],
): Promise<void> {
  const admins = await db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.role, "admin")),
    );
  const userIds = new Set(
    admins.map((admin) => {
      return admin.userId;
    }),
  );
  if (ownerUserId) {
    userIds.add(ownerUserId);
  }
  for (const userId of additionalUserIds) {
    userIds.add(userId);
  }
  if (userIds.size === 0) {
    return;
  }
  await publishUserSignal([...userIds], "feishu:changed");
}
