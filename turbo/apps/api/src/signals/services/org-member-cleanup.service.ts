import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../external/db";
import { suspendOrgMemberAutomations } from "./automations/suspend";

export async function cleanupOrgMemberResources(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await suspendOrgMemberAutomations(db, args);
  signal.throwIfAborted();

  const [installation] = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, args.orgId))
    .limit(1);
  signal.throwIfAborted();

  if (installation) {
    const connections = await db
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.vm0UserId, args.userId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      );
    signal.throwIfAborted();

    if (connections.length > 0) {
      await db.delete(slackOrgConnections).where(
        inArray(
          slackOrgConnections.id,
          connections.map((connection) => {
            return connection.id;
          }),
        ),
      );
      signal.throwIfAborted();
    }
  }

  await db
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.userId, args.userId),
        eq(orgMembersCache.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.userId, args.userId),
        eq(orgMembersMetadata.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();
}
