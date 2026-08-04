import type {
  SlackChannelReference,
  SlackUserMentionedEventConfig,
  SlackUserMentionedEventCreateConfig,
  SlackUserMentionedAutomationReadinessAction,
  SlackUserMentionedAutomationReadinessResponse,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { listConversations } from "../../lib/slack-client";
import type { ReadonlyDb } from "../external/db";
import { settle } from "../utils";
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

type SlackUserMentionedPersistedValidationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "bad-request"; readonly message: string };

type SlackAutomationReadyReadiness = Extract<
  SlackUserMentionedAutomationReadinessResponse,
  { readonly status: "ready" }
>;
type SlackAutomationFeatureDisabledReadiness = Extract<
  SlackUserMentionedAutomationReadinessResponse,
  { readonly reason: "feature-disabled" }
>;
type SlackAutomationDatabaseUpgradeReadiness = Extract<
  SlackUserMentionedAutomationReadinessResponse,
  { readonly reason: "database-upgrade" }
>;
type SlackAutomationNotInstalledReadiness = Extract<
  SlackUserMentionedAutomationReadinessResponse,
  { readonly reason: "not-installed" }
>;
type SlackAutomationOwnerNotConnectedReadiness = Extract<
  SlackUserMentionedAutomationReadinessResponse,
  { readonly reason: "owner-not-connected" }
>;
type SlackAutomationScopeMismatchReadiness = Extract<
  SlackUserMentionedAutomationReadinessResponse,
  { readonly reason: "scope-mismatch" }
>;
type SlackAutomationChannelUnavailableReadiness = Extract<
  SlackUserMentionedAutomationReadinessResponse,
  { readonly reason: "channel-unavailable" }
>;

type SlackChannelTarget =
  | { readonly kind: "selector"; readonly value: string }
  | { readonly kind: "persisted-id"; readonly value: string };

type SlackChannelUnavailableDetail =
  | { readonly kind: "ambiguous-name"; readonly channelName: string }
  | { readonly kind: "unavailable"; readonly value: string };

type SlackConversations = Awaited<ReturnType<typeof listConversations>>;

type SlackUserMentionedAutomationEvaluation =
  | {
      readonly kind: "ready";
      readonly readiness: SlackAutomationReadyReadiness;
      readonly channel: SlackChannelReference;
    }
  | {
      readonly kind: "feature-disabled";
      readonly readiness: SlackAutomationFeatureDisabledReadiness;
    }
  | {
      readonly kind: "database-upgrade";
      readonly readiness: SlackAutomationDatabaseUpgradeReadiness;
    }
  | {
      readonly kind: "not-installed";
      readonly readiness: SlackAutomationNotInstalledReadiness;
    }
  | {
      readonly kind: "owner-not-connected";
      readonly readiness: SlackAutomationOwnerNotConnectedReadiness;
    }
  | {
      readonly kind: "scope-mismatch";
      readonly readiness: SlackAutomationScopeMismatchReadiness;
    }
  | {
      readonly kind: "channel-unavailable";
      readonly readiness: SlackAutomationChannelUnavailableReadiness;
      readonly detail: SlackChannelUnavailableDetail;
    }
  | { readonly kind: "retryable-error"; readonly error: unknown };

function readinessActionMessage(
  message: string,
  action: SlackUserMentionedAutomationReadinessAction | null,
): string {
  return action ? `${message} ${action.label}: ${action.url}` : message;
}

function installAction(args: {
  readonly orgId: string;
  readonly callerUserId: string;
  readonly callerIsAdmin: boolean;
}): Extract<
  SlackUserMentionedAutomationReadinessAction,
  { readonly kind: "install" }
> | null {
  if (!args.callerIsAdmin) {
    return null;
  }
  const url = buildSlackInstallUrl({
    orgId: args.orgId,
    userId: args.callerUserId,
    reinstall: false,
  });
  return url ? { kind: "install", label: "Install Slack", url } : null;
}

function connectAction(args: {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly callerUserId: string;
}): Extract<
  SlackUserMentionedAutomationReadinessAction,
  { readonly kind: "connect" }
> | null {
  if (args.callerUserId !== args.ownerUserId) {
    return null;
  }
  const url = buildSlackConnectUrl({
    orgId: args.orgId,
    userId: args.ownerUserId,
  });
  return url ? { kind: "connect", label: "Connect Slack", url } : null;
}

function reinstallAction(args: {
  readonly orgId: string;
  readonly callerUserId: string;
  readonly callerIsAdmin: boolean;
}): Extract<
  SlackUserMentionedAutomationReadinessAction,
  { readonly kind: "reinstall" }
> | null {
  if (!args.callerIsAdmin) {
    return null;
  }
  const url = buildSlackInstallUrl({
    orgId: args.orgId,
    userId: args.callerUserId,
    reinstall: true,
  });
  return url ? { kind: "reinstall", label: "Update permissions", url } : null;
}

function resolveSlackChannel(
  channels: SlackConversations,
  target: SlackChannelTarget,
):
  | { readonly kind: "ready"; readonly channel: SlackChannelReference }
  | {
      readonly kind: "channel-unavailable";
      readonly detail: SlackChannelUnavailableDetail;
    } {
  const channelById = channels.find((channel) => {
    return channel.id === target.value;
  });
  if (channelById) {
    return { kind: "ready", channel: channelById };
  }
  if (target.kind === "persisted-id") {
    return {
      kind: "channel-unavailable",
      detail: { kind: "unavailable", value: target.value },
    };
  }

  const channelName = target.value.startsWith("#")
    ? target.value.slice(1)
    : target.value;
  const channelsByName = channels.filter((channel) => {
    return channel.name === channelName;
  });
  if (channelsByName.length > 1) {
    return {
      kind: "channel-unavailable",
      detail: { kind: "ambiguous-name", channelName },
    };
  }
  const [channel] = channelsByName;
  return channel
    ? { kind: "ready", channel }
    : {
        kind: "channel-unavailable",
        detail: { kind: "unavailable", value: target.value },
      };
}

async function loadSlackConversationsForAutomation(args: {
  readonly encryptedBotToken: string;
  readonly featureContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly kind: "ok"; readonly channels: SlackConversations }
  | { readonly kind: "retryable-error"; readonly error: unknown }
> {
  const result = await settle(
    (async () => {
      const botToken = await decryptPersistentSecretValue(
        args.encryptedBotToken,
        args.featureContext,
      );
      args.signal.throwIfAborted();
      return await listConversations(botToken, undefined, args.signal);
    })(),
    args.signal,
  );
  if (!result.ok) {
    return { kind: "retryable-error", error: result.error };
  }
  return { kind: "ok", channels: result.value };
}

function slackChannelReadiness(
  channels: SlackConversations,
  target: SlackChannelTarget,
): Extract<
  SlackUserMentionedAutomationEvaluation,
  { readonly kind: "ready" | "channel-unavailable" }
> {
  const channel = resolveSlackChannel(channels, target);
  if (channel.kind === "channel-unavailable") {
    return {
      kind: "channel-unavailable",
      readiness: {
        eventType: "slack-user-mentioned",
        status: "setup-required",
        reason: "channel-unavailable",
        message:
          "The configured Slack channel is unavailable. Invite @Zero to the channel or update the automation channel.",
        action: null,
      },
      detail: channel.detail,
    };
  }
  return {
    kind: "ready",
    readiness: {
      eventType: "slack-user-mentioned",
      status: "ready",
      reason: null,
      message: "Slack is ready for this automation.",
      action: null,
    },
    channel: channel.channel,
  };
}

export async function evaluateSlackUserMentionedAutomation(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly callerUserId: string;
    readonly callerIsAdmin: boolean;
    readonly channel: SlackChannelTarget;
    readonly signal: AbortSignal;
  },
): Promise<SlackUserMentionedAutomationEvaluation> {
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.ownerUserId,
  );
  args.signal.throwIfAborted();
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.SlackUserMentionAutomations,
      featureContext,
    )
  ) {
    return {
      kind: "feature-disabled",
      readiness: {
        eventType: "slack-user-mentioned",
        status: "unavailable",
        reason: "feature-disabled",
        message: "Slack user-mentioned automations are not enabled.",
        action: null,
      },
    };
  }

  // All mutation and readiness boundaries check the rollout prerequisite
  // before Slack calls, so deploy-before-migrate remains a clean state.
  const schemaAvailable = await slackUserMentionedAutomationSchemaAvailable(db);
  args.signal.throwIfAborted();
  if (!schemaAvailable) {
    return {
      kind: "database-upgrade",
      readiness: {
        eventType: "slack-user-mentioned",
        status: "unavailable",
        reason: "database-upgrade",
        message:
          "Slack user-mentioned automations are temporarily unavailable while the database upgrade completes. Try again shortly.",
        action: null,
      },
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
    return {
      kind: "not-installed",
      readiness: {
        eventType: "slack-user-mentioned",
        status: "setup-required",
        reason: "not-installed",
        message: "Install the Zero Slack App before this automation can run.",
        action: installAction(args),
      },
    };
  }

  const [connection] = await db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, args.ownerUserId),
        eq(slackOrgConnections.slackWorkspaceId, installation.workspaceId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!connection) {
    return {
      kind: "owner-not-connected",
      readiness: {
        eventType: "slack-user-mentioned",
        status: "setup-required",
        reason: "owner-not-connected",
        message:
          "The automation owner must connect their Slack account before this automation can run.",
        action: connectAction(args),
      },
    };
  }

  if (!hasAllSlackBotScopes(installation.botScopes)) {
    return {
      kind: "scope-mismatch",
      readiness: {
        eventType: "slack-user-mentioned",
        status: "setup-required",
        reason: "scope-mismatch",
        message: "Update Slack permissions before this automation can run.",
        action: reinstallAction(args),
      },
    };
  }

  const conversations = await loadSlackConversationsForAutomation({
    encryptedBotToken: installation.encryptedBotToken,
    featureContext,
    signal: args.signal,
  });
  if (conversations.kind === "retryable-error") {
    return conversations;
  }
  return slackChannelReadiness(conversations.channels, args.channel);
}

function mutationFailureFromEvaluation(
  evaluation: Exclude<
    SlackUserMentionedAutomationEvaluation,
    { readonly kind: "ready" }
  >,
  args: { readonly callerIsAdmin: boolean; readonly callerIsOwner: boolean },
): { readonly kind: "bad-request"; readonly message: string } {
  switch (evaluation.kind) {
    case "feature-disabled": {
      return {
        kind: "bad-request",
        message: "Slack user-mentioned automations are not enabled",
      };
    }
    case "database-upgrade": {
      return {
        kind: "bad-request",
        message:
          "Slack user-mentioned automations are temporarily unavailable while the database upgrade completes. Try again shortly.",
      };
    }
    case "not-installed": {
      const message = args.callerIsAdmin
        ? "Install the Zero Slack App before using a Slack user-mentioned automation."
        : "Ask a workspace admin to install the Zero Slack App before using a Slack user-mentioned automation.";
      return {
        kind: "bad-request",
        message: readinessActionMessage(message, evaluation.readiness.action),
      };
    }
    case "owner-not-connected": {
      const message = args.callerIsOwner
        ? "Connect your Slack account before using a Slack user-mentioned automation."
        : "The automation owner must connect their Slack account before this Slack user-mentioned automation can run.";
      return {
        kind: "bad-request",
        message: readinessActionMessage(message, evaluation.readiness.action),
      };
    }
    case "scope-mismatch": {
      const message = args.callerIsAdmin
        ? "Update Slack permissions before using a Slack user-mentioned automation."
        : "A workspace admin must update Slack permissions before you can use a Slack user-mentioned automation.";
      return {
        kind: "bad-request",
        message: readinessActionMessage(message, evaluation.readiness.action),
      };
    }
    case "channel-unavailable": {
      return {
        kind: "bad-request",
        message:
          evaluation.detail.kind === "ambiguous-name"
            ? `Multiple Slack channels are named "${evaluation.detail.channelName}". Use the channel ID instead.`
            : `Slack channel "${evaluation.detail.value}" is unavailable. Use an exact active channel name or ID and invite @Zero to the channel.`,
      };
    }
    case "retryable-error": {
      throw evaluation.error;
    }
  }
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
  const evaluation = await evaluateSlackUserMentionedAutomation(db, {
    orgId: args.orgId,
    ownerUserId: args.userId,
    callerUserId: args.userId,
    callerIsAdmin: args.isAdmin,
    channel: { kind: "selector", value: args.eventConfig.channel },
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (evaluation.kind === "ready") {
    return {
      kind: "ok",
      eventConfig: {
        provider: "slack",
        event: "user_mentioned",
        channel: evaluation.channel,
      },
    };
  }
  return mutationFailureFromEvaluation(evaluation, {
    callerIsAdmin: args.isAdmin,
    callerIsOwner: true,
  });
}

export async function validatePersistedSlackUserMentionedAutomationForMutation(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly callerUserId: string;
    readonly callerIsAdmin: boolean;
    readonly channelId: string;
    readonly signal: AbortSignal;
  },
): Promise<SlackUserMentionedPersistedValidationResult> {
  const evaluation = await evaluateSlackUserMentionedAutomation(db, {
    orgId: args.orgId,
    ownerUserId: args.ownerUserId,
    callerUserId: args.callerUserId,
    callerIsAdmin: args.callerIsAdmin,
    channel: { kind: "persisted-id", value: args.channelId },
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (evaluation.kind === "ready") {
    return { kind: "ok" };
  }
  return mutationFailureFromEvaluation(evaluation, {
    callerIsAdmin: args.callerIsAdmin,
    callerIsOwner: args.callerUserId === args.ownerUserId,
  });
}
