import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";

export async function publishBillingChangedForOrg(
  db: Db,
  orgId: string,
): Promise<void> {
  const admins = await db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.role, "admin")),
    );
  const userIds = Array.from(
    new Set(
      admins.map((admin) => {
        return admin.userId;
      }),
    ),
  );

  if (userIds.length === 0) {
    return;
  }

  await publishUserSignal(userIds, "billing:changed");
}
