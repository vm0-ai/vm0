import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { db$, writeDb$ } from "../external/db";
import {
  feishuConfig,
  feishuEnvironmentStatus,
  feishuInstallUrl,
} from "./feishu-config";

export const feishuConnectStatus = (args: {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}) => {
  return computed(async (get) => {
    const db = get(db$);
    const [installation] = await db
      .select()
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.orgId, args.orgId))
      .limit(1);
    const [connection] = installation
      ? await db
          .select({ id: feishuOrgConnections.id })
          .from(feishuOrgConnections)
          .where(
            and(
              eq(
                feishuOrgConnections.feishuTenantKey,
                installation.feishuTenantKey,
              ),
              eq(feishuOrgConnections.vm0UserId, args.userId),
            ),
          )
          .limit(1)
      : [];
    const [defaultAgent] = await db
      .select({ name: zeroAgents.name, displayName: zeroAgents.displayName })
      .from(orgMetadata)
      .leftJoin(zeroAgents, eq(zeroAgents.id, orgMetadata.defaultAgentId))
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    const config = feishuConfig();
    return {
      isInstalled: Boolean(installation),
      isConnected: Boolean(connection),
      isAdmin: args.isAdmin,
      installUrl: config ? feishuInstallUrl() : null,
      tenantKey: installation?.feishuTenantKey ?? null,
      tenantName: installation?.feishuTenantName ?? null,
      defaultAgentName: defaultAgent?.displayName ?? defaultAgent?.name ?? null,
      environment: feishuEnvironmentStatus(),
    };
  });
};

export const disconnectFeishuConnection$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [installation] = await db
      .select({ tenantKey: feishuOrgInstallations.feishuTenantKey })
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return false;
    }
    const rows = await db
      .delete(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.feishuTenantKey, installation.tenantKey),
          eq(feishuOrgConnections.vm0UserId, args.userId),
        ),
      )
      .returning({ id: feishuOrgConnections.id });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);
