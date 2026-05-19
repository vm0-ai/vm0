import { computed, type Computed } from "ccstate";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgCache } from "@vm0/db/schema/org-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { listConversations } from "../../lib/slack-client";
import { decryptSecretValue } from "./crypto.utils";
import type { ApiOrgRole } from "../../types/auth";

export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
];

function hasAllBotScopes(storedScopes: string | null): boolean {
  if (storedScopes === null) {
    return false;
  }
  const parsed: unknown = JSON.parse(storedScopes);
  const scopes: string[] = Array.isArray(parsed) ? parsed : [];
  const stored = new Set(scopes);
  return SLACK_BOT_SCOPES.every((s) => {
    return stored.has(s);
  });
}

function buildSlackInstallUrl(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly reinstall: boolean;
}): string | null {
  const clientId = env("SLACK_CLIENT_ID");
  if (!clientId) {
    return null;
  }
  const url = new URL(`${env("VM0_WEB_URL")}/api/zero/slack/oauth/install`);
  url.searchParams.set("orgId", args.orgId);
  url.searchParams.set("vm0UserId", args.userId);
  if (args.reinstall) {
    url.searchParams.set("reinstall", "1");
  }
  return url.toString();
}

function buildSlackConnectUrl(args: {
  readonly orgId: string;
  readonly userId: string;
}): string | null {
  const clientId = env("SLACK_CLIENT_ID");
  if (!clientId) {
    return null;
  }
  const url = new URL(`${env("VM0_WEB_URL")}/api/zero/slack/oauth/connect`);
  url.searchParams.set("orgId", args.orgId);
  url.searchParams.set("vm0UserId", args.userId);
  return url.toString();
}

interface SlackOrgStatusResult {
  readonly isConnected: boolean;
  readonly isInstalled: boolean;
  readonly isAdmin: boolean;
  readonly workspaceName: string | null;
  readonly installUrl: string | null;
  readonly connectUrl: string | null;
  readonly defaultAgentName: string | null;
  readonly agentOrgSlug: string | null;
  readonly scopeMismatch: boolean | null;
  readonly reinstallUrl: string | null;
}

export function zeroSlackOrgStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: ApiOrgRole;
}): Computed<Promise<SlackOrgStatusResult>> {
  return computed(async (get) => {
    const db = get(db$);

    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    const isAdmin = args.orgRole === "admin";
    let defaultAgentName: string | null = null;
    let agentOrgSlug: string | null = null;

    if (installation) {
      const [[orgMeta], [orgCacheRow]] = await Promise.all([
        db
          .select({ defaultAgentId: orgMetadata.defaultAgentId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, args.orgId))
          .limit(1),
        db
          .select({ slug: orgCache.slug })
          .from(orgCache)
          .where(eq(orgCache.orgId, args.orgId))
          .limit(1),
      ]);

      if (orgMeta?.defaultAgentId) {
        const [agent] = await db
          .select({
            displayName: zeroAgents.displayName,
            name: zeroAgents.name,
          })
          .from(zeroAgents)
          .where(eq(zeroAgents.id, orgMeta.defaultAgentId))
          .limit(1);
        defaultAgentName = agent?.displayName ?? agent?.name ?? null;
      }

      if (orgCacheRow?.slug) {
        agentOrgSlug = orgCacheRow.slug;
      }
    }

    function computeScopeFields(
      installationRow: typeof slackOrgInstallations.$inferSelect,
    ): { scopeMismatch: boolean | null; reinstallUrl: string | null } {
      if (!isAdmin) {
        return { scopeMismatch: null, reinstallUrl: null };
      }
      const scopeMismatch = !hasAllBotScopes(installationRow.botScopes);
      const reinstallUrl = scopeMismatch
        ? buildSlackInstallUrl({
            orgId: args.orgId,
            userId: args.userId,
            reinstall: true,
          })
        : null;
      return { scopeMismatch, reinstallUrl };
    }

    if (!installation) {
      const installUrl = isAdmin
        ? buildSlackInstallUrl({
            orgId: args.orgId,
            userId: args.userId,
            reinstall: false,
          })
        : null;
      return {
        isConnected: false,
        isInstalled: false,
        isAdmin,
        workspaceName: null,
        installUrl,
        connectUrl: null,
        defaultAgentName,
        agentOrgSlug,
        scopeMismatch: null,
        reinstallUrl: null,
      };
    }

    const [connection] = await db
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
      )
      .limit(1);

    if (!connection) {
      const scopeFields = computeScopeFields(installation);
      const connectUrl = buildSlackConnectUrl({
        orgId: args.orgId,
        userId: args.userId,
      });

      return {
        isConnected: false,
        isInstalled: true,
        isAdmin,
        workspaceName: installation.slackWorkspaceName ?? null,
        installUrl: null,
        connectUrl,
        defaultAgentName,
        agentOrgSlug,
        ...scopeFields,
      };
    }

    const scopeFields = computeScopeFields(installation);

    return {
      isConnected: true,
      isInstalled: true,
      isAdmin,
      workspaceName: installation.slackWorkspaceName ?? null,
      installUrl: null,
      connectUrl: null,
      defaultAgentName,
      agentOrgSlug,
      ...scopeFields,
    };
  });
}

export function zeroSlackOrgInstallation(args: {
  readonly orgId: string;
}): Computed<
  Promise<{
    readonly workspaceId: string;
    readonly botToken: string;
    readonly workspaceName: string | null;
  } | null>
> {
  return computed(async (get) => {
    const db = get(db$);

    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    if (!installation) {
      return null;
    }

    const botToken = decryptSecretValue(installation.encryptedBotToken);

    return {
      workspaceId: installation.slackWorkspaceId,
      botToken,
      workspaceName: installation.slackWorkspaceName ?? null,
    };
  });
}

interface SlackChannel {
  readonly id: string;
  readonly name: string;
}

export function zeroSlackChannels(args: {
  readonly orgId: string;
}): Computed<Promise<readonly SlackChannel[] | null>> {
  return computed(async (get) => {
    const installation = await get(zeroSlackOrgInstallation(args));
    if (!installation) {
      return null;
    }

    const channels = await listConversations(installation.botToken);
    return channels;
  });
}
