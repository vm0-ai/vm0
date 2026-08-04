import type {
  SlackUserMentionedEventConfig,
  SlackUserMentionedEventCreateConfig,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { listConversations } from "../../lib/slack-client";
import type { ReadonlyDb } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  buildSlackConnectUrl,
  buildSlackInstallUrl,
  hasAllSlackBotScopes,
} from "./zero-slack-data.service";
import { slackUserMentionedAutomationSchemaAvailable } from "./slack-workflow-automation-schema.service";

type SlackUserMentionedEventConfigPreparationResult =
  | {
      readonly kind: "ok";
      readonly eventConfig: SlackUserMentionedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string };

function messageWithAction(
  message: string,
  action: string,
  actionUrl: string | null,
): string {
  return actionUrl ? `${message} ${action}: ${actionUrl}` : message;
}

function resolveSlackChannel(
  channels: Awaited<ReturnType<typeof listConversations>>,
  selector: string,
): SlackUserMentionedEventConfigPreparationResult {
  const channelById = channels.find((channel) => {
    return channel.id === selector;
  });
  if (channelById) {
    return {
      kind: "ok",
      eventConfig: {
        provider: "slack",
        event: "user_mentioned",
        channel: channelById,
      },
    };
  }

  const channelName = selector.startsWith("#") ? selector.slice(1) : selector;
  const channelsByName = channels.filter((channel) => {
    return channel.name === channelName;
  });
  if (channelsByName.length > 1) {
    return {
      kind: "bad-request",
      message: `Multiple Slack channels are named "${channelName}". Use the channel ID instead.`,
    };
  }
  const [channel] = channelsByName;
  if (!channel) {
    return {
      kind: "bad-request",
      message: `Slack channel "${selector}" is unavailable. Use an exact active channel name or ID and invite @Zero to the channel.`,
    };
  }
  return {
    kind: "ok",
    eventConfig: {
      provider: "slack",
      event: "user_mentioned",
      channel,
    },
  };
}

export async function prepareSlackUserMentionedEventConfigForPersist(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly isAdmin: boolean;
    readonly eventConfig: SlackUserMentionedEventCreateConfig;
    readonly signal: AbortSignal;
  },
): Promise<SlackUserMentionedEventConfigPreparationResult> {
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.userId,
  );
  args.signal.throwIfAborted();
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.SlackUserMentionAutomations,
      featureContext,
    )
  ) {
    return {
      kind: "bad-request",
      message: "Slack user-mentioned automations are not enabled",
    };
  }

  // Create, update, and enable all enter this boundary before a write or Slack
  // API call, so an API deployed ahead of migration 0831 fails cleanly.
  const schemaAvailable = await slackUserMentionedAutomationSchemaAvailable(db);
  args.signal.throwIfAborted();
  if (!schemaAvailable) {
    return {
      kind: "bad-request",
      message:
        "Slack user-mentioned automations are temporarily unavailable while the database upgrade completes. Try again shortly.",
    };
  }

  const [installation] = await db
    .select({
      workspaceId: slackOrgInstallations.slackWorkspaceId,
      encryptedBotToken: slackOrgInstallations.encryptedBotToken,
      botScopes: slackOrgInstallations.botScopes,
    })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, args.orgId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation) {
    const message = args.isAdmin
      ? "Install the Zero Slack App before using a Slack user-mentioned automation."
      : "Ask a workspace admin to install the Zero Slack App before using a Slack user-mentioned automation.";
    return {
      kind: "bad-request",
      message: args.isAdmin
        ? messageWithAction(
            message,
            "Install Slack",
            buildSlackInstallUrl({
              orgId: args.orgId,
              userId: args.userId,
              reinstall: false,
            }),
          )
        : message,
    };
  }

  const [connection] = await db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, args.userId),
        eq(slackOrgConnections.slackWorkspaceId, installation.workspaceId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!connection) {
    return {
      kind: "bad-request",
      message: messageWithAction(
        "Connect your Slack account before using a Slack user-mentioned automation.",
        "Connect Slack",
        buildSlackConnectUrl({
          orgId: args.orgId,
          userId: args.userId,
        }),
      ),
    };
  }

  if (!hasAllSlackBotScopes(installation.botScopes)) {
    const message = args.isAdmin
      ? "Update Slack permissions before using a Slack user-mentioned automation."
      : "A workspace admin must update Slack permissions before you can use a Slack user-mentioned automation.";
    return {
      kind: "bad-request",
      message: args.isAdmin
        ? messageWithAction(
            message,
            "Update permissions",
            buildSlackInstallUrl({
              orgId: args.orgId,
              userId: args.userId,
              reinstall: true,
            }),
          )
        : message,
    };
  }

  const botToken = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
    featureContext,
  );
  args.signal.throwIfAborted();
  const channels = await listConversations(botToken, undefined, args.signal);
  args.signal.throwIfAborted();
  return resolveSlackChannel(channels, args.eventConfig.channel);
}
