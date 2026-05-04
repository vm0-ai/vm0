import { computed, type Computed } from "ccstate";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { listConversations } from "../../lib/slack-client";
import { decryptSecretValue } from "./crypto.utils";

interface SlackOrgStatusResult {
  readonly isConnected: boolean;
  readonly isInstalled: boolean;
  readonly isAdmin: boolean;
  readonly workspaceName: string | null;
  readonly installUrl: string | null;
  readonly connectUrl: string | null;
  readonly defaultAgentName: string | null;
  readonly agentOrgSlug: string | null;
}

export function zeroSlackOrgStatus(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<SlackOrgStatusResult>> {
  return computed(async (get) => {
    const db = get(db$);

    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    if (!installation) {
      return {
        isConnected: false,
        isInstalled: false,
        isAdmin: false,
        workspaceName: null,
        installUrl: null,
        connectUrl: null,
        defaultAgentName: null,
        agentOrgSlug: null,
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
      return {
        isConnected: false,
        isInstalled: true,
        isAdmin: false,
        workspaceName: installation.slackWorkspaceName ?? null,
        installUrl: null,
        connectUrl: null,
        defaultAgentName: null,
        agentOrgSlug: null,
      };
    }

    return {
      isConnected: true,
      isInstalled: true,
      isAdmin: false,
      workspaceName: installation.slackWorkspaceName ?? null,
      installUrl: null,
      connectUrl: null,
      defaultAgentName: null,
      agentOrgSlug: null,
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
}): Computed<Promise<readonly SlackChannel[]>> {
  return computed(async (get) => {
    const installation = await get(zeroSlackOrgInstallation(args));
    if (!installation) {
      return [];
    }

    const channels = await listConversations(installation.botToken);
    return channels;
  });
}
