import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { tapError } from "../utils";

const L = logger("BillingRealtime");

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

  await tapError(publishUserSignal(userIds, "billing:changed"), (error) => {
    L.warn("Failed to publish billing changed signal", { orgId, error });
  });
}
