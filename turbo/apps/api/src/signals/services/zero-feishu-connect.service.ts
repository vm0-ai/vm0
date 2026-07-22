import { command, computed } from "ccstate";
import { and, eq, ne, or } from "drizzle-orm";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { fetchFeishuTenantAccessToken } from "../external/feishu-client";
import { encryptPersistentSecretValue } from "./crypto.utils";
import { feishuCallbackUrl } from "./feishu-config";

export const feishuConnectStatus = (args: {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}) => {
  return computed(async (get) => {
    const db = get(db$);
    const [installation] = await db
      .select({
        id: feishuOrgInstallations.id,
        appId: feishuOrgInstallations.appId,
        tenantKey: feishuOrgInstallations.feishuTenantKey,
        tenantName: feishuOrgInstallations.feishuTenantName,
        callbackVerifiedAt: feishuOrgInstallations.callbackVerifiedAt,
        messageReceivedAt: feishuOrgInstallations.messageReceivedAt,
        defaultAgentId: feishuOrgInstallations.defaultComposeId,
        defaultAgentName: zeroAgents.name,
        defaultAgentDisplayName: zeroAgents.displayName,
      })
      .from(feishuOrgInstallations)
      .leftJoin(
        zeroAgents,
        eq(zeroAgents.id, feishuOrgInstallations.defaultComposeId),
      )
      .where(eq(feishuOrgInstallations.orgId, args.orgId))
      .limit(1);
    const [connection] = installation
      ? await db
          .select({ id: feishuOrgConnections.id })
          .from(feishuOrgConnections)
          .where(
            and(
              eq(feishuOrgConnections.installationId, installation.id),
              eq(feishuOrgConnections.vm0UserId, args.userId),
            ),
          )
          .limit(1)
      : [];
    return {
      isInstalled: Boolean(installation),
      isConnected: Boolean(connection),
      isAdmin: args.isAdmin,
      appId: installation?.appId ?? null,
      callbackUrl: installation ? feishuCallbackUrl(installation.id) : null,
      callbackVerified: Boolean(installation?.callbackVerifiedAt),
      messageReceived: Boolean(installation?.messageReceivedAt),
      tenantKey: installation?.tenantKey ?? null,
      tenantName: installation?.tenantName ?? null,
      defaultAgentId: installation?.defaultAgentId ?? null,
      defaultAgentName:
        installation?.defaultAgentDisplayName ??
        installation?.defaultAgentName ??
        null,
    };
  });
};

export type ConfigureFeishuResult =
  | { readonly kind: "ok" }
  | { readonly kind: "agent_not_found" }
  | { readonly kind: "app_in_use" };

export const configureFeishuInstallation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly appId: string;
      readonly appSecret: string;
      readonly verificationToken: string;
      readonly encryptKey: string;
      readonly defaultAgentId: string;
    },
    signal: AbortSignal,
  ): Promise<ConfigureFeishuResult> => {
    const db = set(writeDb$);
    const [agent] = await db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(
        and(
          eq(zeroAgents.id, args.defaultAgentId),
          eq(zeroAgents.orgId, args.orgId),
          or(
            eq(zeroAgents.visibility, "public"),
            eq(zeroAgents.owner, args.userId),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return { kind: "agent_not_found" };
    }
    const [appOwner] = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.appId, args.appId),
          ne(feishuOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (appOwner) {
      return { kind: "app_in_use" };
    }

    const tenantToken = await fetchFeishuTenantAccessToken({
      appId: args.appId,
      appSecret: args.appSecret,
      signal,
    });
    const context = { orgId: args.orgId, userId: args.userId };
    const [
      encryptedAppSecret,
      encryptedVerificationToken,
      encryptedEncryptKey,
      encryptedTenantAccessToken,
    ] = await Promise.all([
      encryptPersistentSecretValue(args.appSecret, context),
      encryptPersistentSecretValue(args.verificationToken, context),
      encryptPersistentSecretValue(args.encryptKey, context),
      encryptPersistentSecretValue(tenantToken.token, context),
    ]);
    signal.throwIfAborted();
    const [existing] = await db
      .select({
        id: feishuOrgInstallations.id,
        appId: feishuOrgInstallations.appId,
      })
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (existing && existing.appId !== args.appId) {
      await db
        .delete(feishuOrgInstallations)
        .where(eq(feishuOrgInstallations.id, existing.id));
      signal.throwIfAborted();
    }
    const tokenExpiresAt = new Date(
      nowDate().getTime() + tenantToken.expiresInSeconds * 1000,
    );
    await db
      .insert(feishuOrgInstallations)
      .values({
        orgId: args.orgId,
        appId: args.appId,
        encryptedAppSecret,
        encryptedVerificationToken,
        encryptedEncryptKey,
        defaultComposeId: args.defaultAgentId,
        encryptedTenantAccessToken,
        tenantAccessTokenExpiresAt: tokenExpiresAt,
      })
      .onConflictDoUpdate({
        target: feishuOrgInstallations.orgId,
        set: {
          appId: args.appId,
          encryptedAppSecret,
          encryptedVerificationToken,
          encryptedEncryptKey,
          defaultComposeId: args.defaultAgentId,
          feishuTenantKey: null,
          feishuTenantName: null,
          encryptedTenantAccessToken,
          tenantAccessTokenExpiresAt: tokenExpiresAt,
          callbackVerifiedAt: null,
          messageReceivedAt: null,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();
    return { kind: "ok" };
  },
);

export const removeFeishuInstallation$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<boolean> => {
    const rows = await set(writeDb$)
      .delete(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.orgId, orgId))
      .returning({ id: feishuOrgInstallations.id });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

export const disconnectFeishuConnection$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [installation] = await db
      .select({ id: feishuOrgInstallations.id })
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
          eq(feishuOrgConnections.installationId, installation.id),
          eq(feishuOrgConnections.vm0UserId, args.userId),
        ),
      )
      .returning({ id: feishuOrgConnections.id });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);
