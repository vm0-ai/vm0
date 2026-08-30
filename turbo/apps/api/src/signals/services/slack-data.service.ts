import { computed, type Computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { apiUrlForPublicBrand } from "@okouai/core/public-brand";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { webUrl } from "../../lib/web-url";
import { db$ } from "../external/db";
import { listConversations } from "../../lib/slack-client";
import { decryptPersistentSecretValue } from "./crypto.utils";
import type { ApiOrgRole } from "../../types/auth";
import { userFeatureSwitchContext } from "./feature-switches.service";

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
  readonly publicBrand: PublicBrand;
}): string | null {
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return null;
  }
  const url = new URL(
    `${apiUrlForPublicBrand(webUrl(), args.publicBrand)}/api/slack/oauth/install`,
  );
  url.searchParams.set("orgId", args.orgId);
  url.searchParams.set("userId", args.userId);
  url.searchParams.set("publicBrand", args.publicBrand);
  if (args.reinstall) {
    url.searchParams.set("reinstall", "1");
  }
  return url.toString();
}

function buildSlackConnectUrl(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
}): string | null {
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return null;
  }
  const url = new URL(
    `${apiUrlForPublicBrand(webUrl(), args.publicBrand)}/api/slack/oauth/connect`,
  );
  url.searchParams.set("orgId", args.orgId);
  url.searchParams.set("userId", args.userId);
  url.searchParams.set("publicBrand", args.publicBrand);
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
  readonly scopeMismatch: boolean | null;
  readonly reinstallUrl: string | null;
}

export function slackOrgStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: ApiOrgRole;
  readonly publicBrand: PublicBrand;
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

    if (installation) {
      const [orgMeta] = await db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1);

      if (orgMeta?.defaultAgentId) {
        const [agent] = await db
          .select({
            displayName: agents.displayName,
            name: agents.name,
          })
          .from(agents)
          .where(eq(agents.id, orgMeta.defaultAgentId))
          .limit(1);
        defaultAgentName = agent?.displayName ?? agent?.name ?? null;
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
            publicBrand: args.publicBrand,
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
            publicBrand: args.publicBrand,
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
        scopeMismatch: null,
        reinstallUrl: null,
      };
    }

    const [connection] = await db
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.userId, args.userId),
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
        publicBrand: args.publicBrand,
      });

      return {
        isConnected: false,
        isInstalled: true,
        isAdmin,
        workspaceName: installation.slackWorkspaceName ?? null,
        installUrl: null,
        connectUrl,
        defaultAgentName,
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
      ...scopeFields,
    };
  });
}

export function slackOrgInstallation(args: {
  readonly orgId: string;
  readonly userId?: string;
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

    const botToken = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      args.userId
        ? await get(userFeatureSwitchContext(args.orgId, args.userId))
        : { orgId: args.orgId },
    );

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

export function slackChannels(args: {
  readonly orgId: string;
  readonly userId?: string;
}): Computed<Promise<readonly SlackChannel[] | null>> {
  return computed(async (get) => {
    const installation = await get(slackOrgInstallation(args));
    if (!installation) {
      return null;
    }

    const channels = await listConversations(installation.botToken);
    return channels;
  });
}
