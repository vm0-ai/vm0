import { computed, type Computed } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

export function zeroSlackConnectStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}): Computed<
  Promise<{
    readonly isConnected: boolean;
    readonly isAdmin: boolean;
    readonly workspaceName?: string | null;
    readonly defaultAgentName?: string | null;
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const [orgInstallation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    const [connection] = orgInstallation
      ? await db
          .select()
          .from(slackOrgConnections)
          .where(
            and(
              eq(slackOrgConnections.vm0UserId, args.userId),
              eq(
                slackOrgConnections.slackWorkspaceId,
                orgInstallation.slackWorkspaceId,
              ),
            ),
          )
          .limit(1)
      : [];

    if (!connection) {
      return { isConnected: false, isAdmin: args.isAdmin };
    }

    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);

    const [agent] = metadata?.defaultAgentId
      ? await db
          .select({ name: zeroAgents.name })
          .from(agentComposes)
          .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
          .where(eq(agentComposes.id, metadata.defaultAgentId))
          .limit(1)
      : [];

    return {
      isConnected: true,
      workspaceName: orgInstallation?.slackWorkspaceName ?? null,
      isAdmin: args.isAdmin,
      defaultAgentName: agent?.name ?? null,
    };
  });
}
