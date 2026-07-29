import { command, computed } from "ccstate";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type {
  FeishuConnectStatus,
  FeishuInstallationStatus,
} from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { logger } from "../../lib/log";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import {
  fetchFeishuBotInfo,
  fetchFeishuTenantAccessToken,
  getFeishuTenantAccessToken,
} from "../external/feishu-client";
import { tapError } from "../utils";
import { encryptPersistentSecretValue } from "./crypto.utils";
import { feishuCallbackUrl, feishuOAuthAppCallbackUrl } from "./feishu-config";
import { buildFeishuOAuthConnectUrl } from "./feishu-oauth-state";

const L = logger("ZeroFeishuConnect");

async function loadFeishuInstallations(db: ReadonlyDb, orgId: string) {
  return await db
    .select({
      id: feishuOrgInstallations.id,
      appId: feishuOrgInstallations.appId,
      botName: feishuOrgInstallations.botName,
      botAvatarUrl: feishuOrgInstallations.botAvatarUrl,
      tenantKey: feishuOrgInstallations.feishuTenantKey,
      tenantName: feishuOrgInstallations.feishuTenantName,
      callbackVerifiedAt: feishuOrgInstallations.callbackVerifiedAt,
      setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
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
    .where(eq(feishuOrgInstallations.orgId, orgId))
    .orderBy(asc(feishuOrgInstallations.createdAt));
}

type FeishuInstallationRow = Awaited<
  ReturnType<typeof loadFeishuInstallations>
>[number];

async function loadConnectedFeishuUsers(
  db: ReadonlyDb,
  installations: readonly FeishuInstallationRow[],
  userId: string,
): Promise<Map<string, string | null>> {
  if (installations.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      installationId: feishuOrgConnections.installationId,
      userName: feishuOrgConnections.feishuUserName,
    })
    .from(feishuOrgConnections)
    .where(
      and(
        inArray(
          feishuOrgConnections.installationId,
          installations.map((installation) => {
            return installation.id;
          }),
        ),
        eq(feishuOrgConnections.vm0UserId, userId),
      ),
    );
  return new Map(
    rows.map((connection) => {
      return [connection.installationId, connection.userName] as const;
    }),
  );
}

function toFeishuInstallationStatus(
  installation: FeishuInstallationRow,
  connectedUserNameByInstallationId: ReadonlyMap<string, string | null>,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): FeishuInstallationStatus {
  return {
    id: installation.id,
    isConnected: connectedUserNameByInstallationId.has(installation.id),
    connectedUserName:
      connectedUserNameByInstallationId.get(installation.id) ?? null,
    appId: installation.appId,
    botName: installation.botName,
    botAvatarUrl: installation.botAvatarUrl,
    callbackUrl: feishuCallbackUrl(installation.id),
    oauthRedirectUrl: feishuOAuthAppCallbackUrl(),
    connectUrl: installation.setupCompletedAt
      ? buildFeishuOAuthConnectUrl({
          installationId: installation.id,
          orgId: args.orgId,
          userId: args.userId,
        })
      : null,
    callbackVerified: Boolean(installation.callbackVerifiedAt),
    setupCompleted: Boolean(installation.setupCompletedAt),
    messageReceived: Boolean(installation.messageReceivedAt),
    tenantKey: installation.tenantKey,
    tenantName: installation.tenantName,
    defaultAgentId: installation.defaultAgentId,
    defaultAgentName:
      installation.defaultAgentDisplayName ??
      installation.defaultAgentName ??
      null,
  };
}

function feishuStatusResponse(
  installations: readonly FeishuInstallationStatus[],
  args: {
    readonly isAdmin: boolean;
    readonly preferredInstallationId?: string;
  },
): FeishuConnectStatus {
  const installation =
    installations.find((candidate) => {
      return candidate.id === args.preferredInstallationId;
    }) ?? installations[0];
  if (!installation) {
    return {
      isInstalled: false,
      isConnected: false,
      connectedUserName: null,
      isAdmin: args.isAdmin,
      appId: null,
      botName: null,
      botAvatarUrl: null,
      callbackUrl: null,
      oauthRedirectUrl: null,
      connectUrl: null,
      callbackVerified: false,
      messageReceived: false,
      tenantKey: null,
      tenantName: null,
      defaultAgentId: null,
      defaultAgentName: null,
      installationId: null,
      installations: [],
    };
  }
  return {
    isInstalled: true,
    isConnected: installation.isConnected,
    connectedUserName: installation.connectedUserName ?? null,
    isAdmin: args.isAdmin,
    appId: installation.appId,
    botName: installation.botName,
    botAvatarUrl: installation.botAvatarUrl,
    callbackUrl: installation.callbackUrl,
    oauthRedirectUrl: installation.oauthRedirectUrl ?? null,
    connectUrl: installation.connectUrl ?? null,
    callbackVerified: installation.callbackVerified,
    messageReceived: installation.messageReceived,
    tenantKey: installation.tenantKey,
    tenantName: installation.tenantName,
    defaultAgentId: installation.defaultAgentId,
    defaultAgentName: installation.defaultAgentName,
    installationId: installation.id,
    installations: [...installations],
  };
}

export const feishuConnectStatus = (args: {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly preferredInstallationId?: string;
}) => {
  return computed(async (get) => {
    const db = get(db$);
    const rows = await loadFeishuInstallations(db, args.orgId);
    const connectedUsers = await loadConnectedFeishuUsers(
      db,
      rows,
      args.userId,
    );
    const installations = rows.map((installation) => {
      return toFeishuInstallationStatus(installation, connectedUsers, args);
    });
    return feishuStatusResponse(installations, args);
  });
};

interface ConfigureFeishuArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly defaultAgentId: string;
  readonly installationId?: string;
  readonly createNew?: boolean;
}

export type ConfigureFeishuResult =
  | { readonly kind: "ok"; readonly installationId: string }
  | { readonly kind: "agent_not_found" }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "app_in_use" }
  | { readonly kind: "installation_exists" };

interface PreparedFeishuInstallation {
  readonly encryptedAppSecret: string;
  readonly encryptedVerificationToken: string;
  readonly encryptedEncryptKey: string;
  readonly encryptedTenantAccessToken: string;
  readonly tokenExpiresAt: Date;
}

async function prepareFeishuInstallation(
  input: ConfigureFeishuArgs,
  signal: AbortSignal,
): Promise<PreparedFeishuInstallation> {
  const tenantToken = await fetchFeishuTenantAccessToken({
    appId: input.appId,
    appSecret: input.appSecret,
    signal,
  });
  const context = {
    orgId: input.orgId,
    userId: input.userId,
  };
  const [
    encryptedAppSecret,
    encryptedVerificationToken,
    encryptedEncryptKey,
    encryptedTenantAccessToken,
  ] = await Promise.all([
    encryptPersistentSecretValue(input.appSecret, context),
    encryptPersistentSecretValue(input.verificationToken, context),
    encryptPersistentSecretValue(input.encryptKey, context),
    encryptPersistentSecretValue(tenantToken.token, context),
  ]);
  signal.throwIfAborted();
  return {
    encryptedAppSecret,
    encryptedVerificationToken,
    encryptedEncryptKey,
    encryptedTenantAccessToken,
    tokenExpiresAt: new Date(
      nowDate().getTime() + tenantToken.expiresInSeconds * 1000,
    ),
  };
}

async function persistFeishuInstallation(args: {
  readonly db: Pick<Db, "insert" | "update">;
  readonly input: ConfigureFeishuArgs;
  readonly prepared: PreparedFeishuInstallation;
  readonly targetInstallationId: string | undefined;
  readonly signal: AbortSignal;
}): Promise<ConfigureFeishuResult> {
  if (args.targetInstallationId) {
    await args.db
      .update(feishuOrgInstallations)
      .set({
        appId: args.input.appId,
        botOpenId: null,
        botName: null,
        botAvatarUrl: null,
        encryptedAppSecret: args.prepared.encryptedAppSecret,
        encryptedVerificationToken: args.prepared.encryptedVerificationToken,
        encryptedEncryptKey: args.prepared.encryptedEncryptKey,
        defaultComposeId: args.input.defaultAgentId,
        feishuTenantKey: null,
        feishuTenantName: null,
        encryptedTenantAccessToken: args.prepared.encryptedTenantAccessToken,
        tenantAccessTokenExpiresAt: args.prepared.tokenExpiresAt,
        callbackVerifiedAt: null,
        setupCompletedAt: null,
        messageReceivedAt: null,
        updatedAt: nowDate(),
      })
      .where(eq(feishuOrgInstallations.id, args.targetInstallationId));
    args.signal.throwIfAborted();
    return {
      kind: "ok",
      installationId: args.targetInstallationId,
    };
  }
  const [created] = await args.db
    .insert(feishuOrgInstallations)
    .values({
      orgId: args.input.orgId,
      ownerUserId: args.input.userId,
      appId: args.input.appId,
      encryptedAppSecret: args.prepared.encryptedAppSecret,
      encryptedVerificationToken: args.prepared.encryptedVerificationToken,
      encryptedEncryptKey: args.prepared.encryptedEncryptKey,
      defaultComposeId: args.input.defaultAgentId,
      encryptedTenantAccessToken: args.prepared.encryptedTenantAccessToken,
      tenantAccessTokenExpiresAt: args.prepared.tokenExpiresAt,
    })
    .onConflictDoNothing({
      target: feishuOrgInstallations.appId,
    })
    .returning({ id: feishuOrgInstallations.id });
  args.signal.throwIfAborted();
  return created
    ? { kind: "ok", installationId: created.id }
    : { kind: "app_in_use" };
}

type FeishuInstallationTargetResult =
  | {
      readonly kind: "target";
      readonly installationId: string | undefined;
    }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "app_in_use" }
  | { readonly kind: "installation_exists" };

async function resolveFeishuInstallationTarget(
  db: Pick<Db, "select">,
  args: ConfigureFeishuArgs,
  signal: AbortSignal,
): Promise<FeishuInstallationTargetResult> {
  const [appOwner] = await db
    .select({
      id: feishuOrgInstallations.id,
      orgId: feishuOrgInstallations.orgId,
    })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.appId, args.appId))
    .limit(1);
  signal.throwIfAborted();
  if (appOwner && appOwner.orgId !== args.orgId) {
    return { kind: "app_in_use" };
  }
  if (args.installationId && appOwner && appOwner.id !== args.installationId) {
    return { kind: "app_in_use" };
  }
  let targetInstallationId =
    args.installationId ?? (args.createNew ? undefined : appOwner?.id);
  if (!targetInstallationId) {
    const [existingInstallation] = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.orgId, args.orgId))
      .orderBy(asc(feishuOrgInstallations.createdAt))
      .limit(1);
    signal.throwIfAborted();
    if (existingInstallation && args.createNew) {
      return { kind: "installation_exists" };
    }
    targetInstallationId = existingInstallation?.id;
  }
  if (targetInstallationId) {
    const [installation] = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, targetInstallationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return { kind: "installation_not_found" };
    }
  }
  return { kind: "target", installationId: targetInstallationId };
}

export const configureFeishuInstallation$ = command(
  async (
    { set },
    args: ConfigureFeishuArgs,
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
    const preflight = await resolveFeishuInstallationTarget(db, args, signal);
    if (preflight.kind !== "target") {
      return preflight;
    }
    const prepared = await prepareFeishuInstallation(args, signal);
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('feishu_installation:' || ${args.orgId}))`,
      );
      signal.throwIfAborted();
      const target = await resolveFeishuInstallationTarget(tx, args, signal);
      if (target.kind !== "target") {
        return target;
      }
      return await persistFeishuInstallation({
        db: tx,
        input: args,
        prepared,
        targetInstallationId: target.installationId,
        signal,
      });
    });
  },
);

export const removeFeishuInstallation$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly installationId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const rows = await set(writeDb$)
      .delete(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.id, args.installationId),
        ),
      )
      .returning({ id: feishuOrgInstallations.id });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

export const disconnectFeishuConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly installationId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const installations = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.id, args.installationId),
        ),
      );
    signal.throwIfAborted();
    if (installations.length === 0) {
      return false;
    }
    const rows = await db
      .delete(feishuOrgConnections)
      .where(
        and(
          inArray(
            feishuOrgConnections.installationId,
            installations.map((installation) => {
              return installation.id;
            }),
          ),
          eq(feishuOrgConnections.vm0UserId, args.userId),
        ),
      )
      .returning({ id: feishuOrgConnections.id });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

type UpdateFeishuInstallationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "agent_not_found" }
  | { readonly kind: "installation_not_found" };

export const updateFeishuInstallationAgent$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly installationId: string;
      readonly defaultAgentId: string;
      readonly setupCompleted?: boolean;
    },
    signal: AbortSignal,
  ): Promise<UpdateFeishuInstallationResult> => {
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
    const botInfo = args.setupCompleted
      ? await tapError(
          (async () => {
            return await fetchFeishuBotInfo({
              tenantAccessToken: await getFeishuTenantAccessToken({
                db,
                installationId: args.installationId,
                signal,
              }),
              signal,
            });
          })(),
          (error) => {
            L.warn("Failed to load Feishu bot profile", {
              error,
              installationId: args.installationId,
            });
          },
        )
      : undefined;
    signal.throwIfAborted();
    const rows = await db
      .update(feishuOrgInstallations)
      .set({
        defaultComposeId: args.defaultAgentId,
        ...(args.setupCompleted
          ? {
              ...(botInfo
                ? {
                    botOpenId: botInfo.openId,
                    botName: botInfo.name,
                    botAvatarUrl: botInfo.avatarUrl,
                  }
                : {}),
              setupCompletedAt: nowDate(),
            }
          : {}),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(feishuOrgInstallations.id, args.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
        ),
      )
      .returning({ id: feishuOrgInstallations.id });
    signal.throwIfAborted();
    return rows.length > 0
      ? { kind: "ok" }
      : { kind: "installation_not_found" };
  },
);
