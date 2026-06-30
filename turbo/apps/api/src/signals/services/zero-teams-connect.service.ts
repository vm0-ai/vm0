import { command, computed, type Computed } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsUserAgentPreferences } from "@vm0/db/schema/teams-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import type { TeamsInboundActivity } from "@vm0/api-contracts/contracts/zero-teams-bot";
import { and, eq, isNull, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import { ensureUserArtifactStorage } from "./agent-run-storage.service";

type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;

type TeamsConnectResult =
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly connectionId: string;
      readonly role: "admin" | "member";
      readonly installation: TeamsInstallation;
    };

type TeamsDisconnectResult =
  | { readonly kind: "not_found"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly orgId: string;
      readonly userId: string;
    };

type TeamsInstallationActivityResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "upserted"; readonly installation: TeamsInstallation }
  | {
      readonly kind: "removed";
      readonly orgId: string | null;
      readonly userIds: readonly string[];
    };

const installationNotFoundMessage =
  "Teams installation not found. Please install the Teams app first.";
const adminRequiredMessage =
  "Only org admins can connect an unconfigured Teams installation. Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Teams installation. Please switch to the correct organization in the platform sidebar before connecting.";
const connectionNotFoundMessage = "Teams connection not found.";

function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function setOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | null | undefined,
): void {
  const normalized = nonEmpty(value);
  if (normalized) {
    params.set(key, normalized);
  }
}

function buildTeamsBrowserConnectUrl(args: {
  readonly tenantId: string;
  readonly teamsUserId: string;
  readonly teamsUserDisplayName?: string | null;
  readonly teamsUserPrincipalName?: string | null;
  readonly conversationId?: string | null;
  readonly channelId?: string | null;
  readonly threadId?: string | null;
  readonly orgId?: string | null;
}): string {
  const params = new URLSearchParams({
    tenantId: args.tenantId,
    teamsUserId: args.teamsUserId,
  });
  setOptionalParam(params, "displayName", args.teamsUserDisplayName);
  setOptionalParam(params, "upn", args.teamsUserPrincipalName);
  setOptionalParam(params, "conversationId", args.conversationId);
  setOptionalParam(params, "channelId", args.channelId);
  setOptionalParam(params, "threadId", args.threadId);
  setOptionalParam(params, "orgId", args.orgId);
  return `${env("APP_URL")}/api/zero/teams/connect?${params.toString()}`;
}

export function buildTeamsConnectUrlForActivity(args: {
  readonly activity: TeamsInboundActivity;
  readonly installation?: TeamsInstallation | null;
}): string | null {
  if (
    args.activity.kind !== "message" ||
    args.activity.sender.id.length === 0
  ) {
    return null;
  }

  return buildTeamsBrowserConnectUrl({
    tenantId: args.activity.tenantId,
    teamsUserId: args.activity.sender.id,
    teamsUserDisplayName: args.activity.sender.name,
    teamsUserPrincipalName: args.activity.sender.userPrincipalName,
    conversationId: args.activity.conversationId,
    channelId: args.activity.channelId,
    threadId: args.activity.threadId,
    orgId: args.installation?.orgId,
  });
}

async function upsertTeamsConnection(
  writeDb: Db,
  args: {
    readonly teamsUserId: string;
    readonly teamsTenantId: string;
    readonly vm0UserId: string;
    readonly teamsUserDisplayName?: string;
    readonly teamsUserPrincipalName?: string;
  },
): Promise<string> {
  const [connection] = await writeDb
    .insert(teamsOrgConnections)
    .values({
      teamsUserId: args.teamsUserId,
      teamsTenantId: args.teamsTenantId,
      vm0UserId: args.vm0UserId,
      teamsUserDisplayName: args.teamsUserDisplayName,
      teamsUserPrincipalName: args.teamsUserPrincipalName,
    })
    .onConflictDoNothing({
      target: [
        teamsOrgConnections.teamsUserId,
        teamsOrgConnections.teamsTenantId,
      ],
    })
    .returning({ id: teamsOrgConnections.id });

  if (connection) {
    return connection.id;
  }

  const [existing] = await writeDb
    .select({ id: teamsOrgConnections.id })
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.teamsUserId, args.teamsUserId),
        eq(teamsOrgConnections.teamsTenantId, args.teamsTenantId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Teams connection upsert did not return a row");
  }

  return existing.id;
}

async function resolveDefaultComposeId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function getUserAgentPreference(
  db: ReadonlyDb,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [preference] = await db
    .select({ selectedComposeId: teamsUserAgentPreferences.selectedComposeId })
    .from(teamsUserAgentPreferences)
    .where(
      and(
        eq(teamsUserAgentPreferences.vm0UserId, vm0UserId),
        eq(teamsUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return preference?.selectedComposeId ?? null;
}

async function resolveEffectiveComposeId(
  db: ReadonlyDb,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const override = await getUserAgentPreference(db, vm0UserId, orgId);
  if (override) {
    const [agent] = await db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.id, override), eq(zeroAgents.orgId, orgId)))
      .limit(1);
    if (agent?.id) {
      return override;
    }
  }
  return resolveDefaultComposeId(db, orgId);
}

async function getTeamsAgentName(
  db: ReadonlyDb,
  composeId: string,
): Promise<string | undefined> {
  const [agent] = await db
    .select({ name: zeroAgents.name, displayName: zeroAgents.displayName })
    .from(agentComposes)
    .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return agent?.displayName ?? agent?.name;
}

export function zeroTeamsConnectStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}): Computed<
  Promise<{
    readonly isInstalled: boolean;
    readonly isConnected: boolean;
    readonly isAdmin: boolean;
    readonly tenantId?: string | null;
    readonly tenantName?: string | null;
    readonly teamId?: string | null;
    readonly teamName?: string | null;
    readonly defaultAgentName?: string | null;
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const [installation] = await db
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);

    if (!installation) {
      return {
        isInstalled: false,
        isConnected: false,
        isAdmin: args.isAdmin,
      };
    }

    const [connection] = await db
      .select()
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.vm0UserId, args.userId),
          eq(teamsOrgConnections.teamsTenantId, installation.teamsTenantId),
        ),
      )
      .limit(1);

    let defaultAgentName: string | null = null;
    if (connection) {
      const composeId = await resolveEffectiveComposeId(
        db,
        args.userId,
        args.orgId,
      );
      defaultAgentName = composeId
        ? ((await getTeamsAgentName(db, composeId)) ?? null)
        : null;
    }

    return {
      isInstalled: true,
      isConnected: Boolean(connection),
      isAdmin: args.isAdmin,
      tenantId: installation.teamsTenantId,
      tenantName: installation.teamsTenantName,
      teamId: installation.teamsTeamId,
      teamName: installation.teamsTeamName,
      defaultAgentName,
    };
  });
}

function installationMetadataPatch(args: {
  readonly tenantName?: string | null;
  readonly teamId?: string | null;
  readonly teamName?: string | null;
  readonly teamsAppId?: string | null;
  readonly botId?: string | null;
  readonly botName?: string | null;
  readonly serviceUrl?: string | null;
}): Partial<typeof teamsOrgInstallations.$inferInsert> {
  return {
    ...(nonEmpty(args.tenantName) ? { teamsTenantName: args.tenantName } : {}),
    ...(nonEmpty(args.teamId) ? { teamsTeamId: args.teamId } : {}),
    ...(nonEmpty(args.teamName) ? { teamsTeamName: args.teamName } : {}),
    ...(nonEmpty(args.teamsAppId) ? { teamsAppId: args.teamsAppId } : {}),
    ...(nonEmpty(args.botId) ? { botId: args.botId } : {}),
    ...(nonEmpty(args.botName) ? { botName: args.botName } : {}),
    ...(nonEmpty(args.serviceUrl) ? { serviceUrl: args.serviceUrl } : {}),
    updatedAt: nowDate(),
  };
}

async function updateTeamsInstallationMetadata(
  writeDb: Db,
  tenantId: string,
  args: Parameters<typeof installationMetadataPatch>[0],
): Promise<void> {
  const patch = installationMetadataPatch(args);
  await writeDb
    .update(teamsOrgInstallations)
    .set(patch)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId));
}

export const connectTeamsInstallation$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: "admin" | "member";
      readonly tenantId: string;
      readonly teamsUserId: string;
      readonly teamsUserDisplayName?: string;
      readonly teamsUserPrincipalName?: string;
      readonly teamId?: string;
      readonly teamName?: string;
      readonly serviceUrl?: string;
    },
    signal: AbortSignal,
  ): Promise<TeamsConnectResult> => {
    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.teamsTenantId, args.tenantId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return { kind: "not_found", message: installationNotFoundMessage };
    }

    if (installation.orgId === null) {
      if (args.orgRole !== "admin") {
        return { kind: "forbidden", message: adminRequiredMessage };
      }

      await updateTeamsInstallationMetadata(writeDb, args.tenantId, {
        teamId: args.teamId,
        teamName: args.teamName,
        serviceUrl: args.serviceUrl,
      });
      signal.throwIfAborted();

      const [updated] = await writeDb
        .update(teamsOrgInstallations)
        .set({
          orgId: args.orgId,
          installedByUserId: args.userId,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(teamsOrgInstallations.teamsTenantId, args.tenantId),
            isNull(teamsOrgInstallations.orgId),
          ),
        )
        .returning();
      signal.throwIfAborted();

      let boundInstallation = updated;
      if (!boundInstallation) {
        const [existing] = await writeDb
          .select()
          .from(teamsOrgInstallations)
          .where(eq(teamsOrgInstallations.teamsTenantId, args.tenantId))
          .limit(1);
        signal.throwIfAborted();
        if (!existing) {
          return { kind: "not_found", message: installationNotFoundMessage };
        }
        if (existing.orgId !== args.orgId) {
          return { kind: "forbidden", message: orgMismatchMessage };
        }
        boundInstallation = existing;
      }

      const connectionId = await upsertTeamsConnection(writeDb, {
        teamsUserId: args.teamsUserId,
        teamsTenantId: args.tenantId,
        vm0UserId: args.userId,
        teamsUserDisplayName: args.teamsUserDisplayName,
        teamsUserPrincipalName: args.teamsUserPrincipalName,
      });
      signal.throwIfAborted();

      await get(
        ensureUserArtifactStorage({
          db: writeDb,
          orgId: args.orgId,
          userId: args.userId,
          name: "artifact",
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        }),
      );
      signal.throwIfAborted();

      return {
        kind: "ok",
        connectionId,
        role: "admin",
        installation: boundInstallation,
      };
    }

    if (installation.orgId !== args.orgId) {
      return { kind: "forbidden", message: orgMismatchMessage };
    }

    await updateTeamsInstallationMetadata(writeDb, args.tenantId, {
      teamId: args.teamId,
      teamName: args.teamName,
      serviceUrl: args.serviceUrl,
    });
    signal.throwIfAborted();

    const connectionId = await upsertTeamsConnection(writeDb, {
      teamsUserId: args.teamsUserId,
      teamsTenantId: args.tenantId,
      vm0UserId: args.userId,
      teamsUserDisplayName: args.teamsUserDisplayName,
      teamsUserPrincipalName: args.teamsUserPrincipalName,
    });
    signal.throwIfAborted();

    await get(
      ensureUserArtifactStorage({
        db: writeDb,
        orgId: args.orgId,
        userId: args.userId,
        name: "artifact",
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
      }),
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      connectionId,
      role: args.orgRole,
      installation,
    };
  },
);

export const disconnectTeamsConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<TeamsDisconnectResult> => {
    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return { kind: "not_found", message: connectionNotFoundMessage };
    }

    const [connection] = await writeDb
      .select({ id: teamsOrgConnections.id })
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.vm0UserId, args.userId),
          eq(teamsOrgConnections.teamsTenantId, installation.teamsTenantId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!connection) {
      return { kind: "not_found", message: connectionNotFoundMessage };
    }

    await writeDb
      .delete(teamsOrgConnections)
      .where(eq(teamsOrgConnections.id, connection.id));
    signal.throwIfAborted();

    return { kind: "ok", orgId: args.orgId, userId: args.userId };
  },
);

export const publishTeamsChanged$ = command(
  async (
    { get },
    args: {
      readonly orgId?: string | null;
      readonly userIds?: readonly string[];
      readonly payload?: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const userIds = new Set(args.userIds ?? []);

    if (args.orgId) {
      const db = get(db$);
      const admins = await db
        .select({ userId: orgMembersCache.userId })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, args.orgId),
            eq(orgMembersCache.role, "admin"),
          ),
        );
      signal.throwIfAborted();
      for (const admin of admins) {
        userIds.add(admin.userId);
      }
    }

    if (userIds.size === 0) {
      return;
    }

    const publishResult = await settle(
      publishUserSignal([...userIds], "teams:changed", args.payload),
    );
    signal.throwIfAborted();
    if (!publishResult.ok) {
      throw publishResult.error;
    }
  },
);

function activityRecipient(activity: TeamsInboundActivity): {
  readonly id: string | null;
  readonly name: string | null;
} {
  if (activity.kind === "message") {
    return {
      id: activity.recipient?.id ?? null,
      name: activity.recipient?.name ?? null,
    };
  }
  if (
    activity.kind === "conversation_update" ||
    activity.kind === "installation_update" ||
    activity.kind === "bot_removed"
  ) {
    return {
      id: activity.recipient?.id ?? null,
      name: activity.recipient?.name ?? null,
    };
  }
  return { id: null, name: null };
}

export const recordTeamsInstallationActivity$ = command(
  async (
    { set },
    activity: TeamsInboundActivity,
    signal: AbortSignal,
  ): Promise<TeamsInstallationActivityResult> => {
    if (activity.kind === "unsupported") {
      return { kind: "ignored" };
    }

    const writeDb = set(writeDb$);

    if (activity.kind === "bot_removed") {
      const [installation] = await writeDb
        .select()
        .from(teamsOrgInstallations)
        .where(eq(teamsOrgInstallations.teamsTenantId, activity.tenantId))
        .limit(1);
      signal.throwIfAborted();

      if (!installation) {
        return { kind: "removed", orgId: null, userIds: [] };
      }

      const connections = await writeDb
        .select({ userId: teamsOrgConnections.vm0UserId })
        .from(teamsOrgConnections)
        .where(eq(teamsOrgConnections.teamsTenantId, activity.tenantId));
      signal.throwIfAborted();

      await writeDb
        .delete(teamsOrgConnections)
        .where(eq(teamsOrgConnections.teamsTenantId, activity.tenantId));
      signal.throwIfAborted();

      if (installation.orgId) {
        await writeDb
          .delete(teamsUserAgentPreferences)
          .where(eq(teamsUserAgentPreferences.orgId, installation.orgId));
        signal.throwIfAborted();
      }

      await writeDb
        .delete(teamsOrgInstallations)
        .where(eq(teamsOrgInstallations.teamsTenantId, activity.tenantId));
      signal.throwIfAborted();

      return {
        kind: "removed",
        orgId: installation.orgId,
        userIds: connections.map((connection) => {
          return connection.userId;
        }),
      };
    }

    const recipient = activityRecipient(activity);
    const [installation] = await writeDb
      .insert(teamsOrgInstallations)
      .values({
        teamsTenantId: activity.tenantId,
        teamsTenantName: activity.tenantName,
        teamsTeamId: activity.teamId,
        teamsTeamName: activity.teamName,
        teamsAppId: activity.teamsAppId,
        botId: recipient.id,
        botName: recipient.name,
        serviceUrl: activity.serviceUrl,
      })
      .onConflictDoUpdate({
        target: teamsOrgInstallations.teamsTenantId,
        set: {
          teamsTenantName: sql`coalesce(excluded.teams_tenant_name, ${teamsOrgInstallations.teamsTenantName})`,
          teamsTeamId: sql`coalesce(excluded.teams_team_id, ${teamsOrgInstallations.teamsTeamId})`,
          teamsTeamName: sql`coalesce(excluded.teams_team_name, ${teamsOrgInstallations.teamsTeamName})`,
          teamsAppId: sql`coalesce(excluded.teams_app_id, ${teamsOrgInstallations.teamsAppId})`,
          botId: sql`coalesce(excluded.bot_id, ${teamsOrgInstallations.botId})`,
          botName: sql`coalesce(excluded.bot_name, ${teamsOrgInstallations.botName})`,
          serviceUrl: sql`coalesce(excluded.service_url, ${teamsOrgInstallations.serviceUrl})`,
          updatedAt: nowDate(),
        },
      })
      .returning();
    signal.throwIfAborted();

    if (!installation) {
      throw new Error("Failed to upsert Teams installation");
    }

    return { kind: "upserted", installation };
  },
);
