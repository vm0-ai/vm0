import { randomUUID } from "node:crypto";

import type { ChatFeishuMessageFiles } from "@vm0/db/jsonb-contracts/chat-feishu-context";
import type {
  ChatSlackMentionDisplayNames,
  ChatSlackMessageFiles,
} from "@vm0/db/jsonb-contracts/chat-slack-context";
import type { ChatTeamsMessageFiles } from "@vm0/db/jsonb-contracts/chat-teams-context";
import type { JsonObject } from "@vm0/db/jsonb-contracts/shared";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatAutomationContext } from "@vm0/db/schema/chat-automation-context";
import { chatAgentphoneContext } from "@vm0/db/schema/chat-agentphone-context";
import { chatEventInputParams } from "@vm0/db/schema/chat-event-input-params";
import { chatFeishuContext } from "@vm0/db/schema/chat-feishu-context";
import { chatGithubContext } from "@vm0/db/schema/chat-github-context";
import { chatGoalContext } from "@vm0/db/schema/chat-goal-context";
import { chatMorningBriefContext } from "@vm0/db/schema/chat-morning-brief-context";
import { chatSlackContext } from "@vm0/db/schema/chat-slack-context";
import { chatTeamsContext } from "@vm0/db/schema/chat-teams-context";
import { chatTelegramContext } from "@vm0/db/schema/chat-telegram-context";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { and, count, eq, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { nowDate } from "../lib/time";
import {
  insertChatEvent,
  replaceChatEvent,
} from "../signals/services/zero-chat-event.service";
import { createChatEventSourcePart } from "../signals/services/chat-event-annotation.service";
import { createUserMessageDocument } from "../signals/services/zero-chat-user-message.service";
import type { GitHubDeliveryTarget } from "../signals/services/github-chat-callback-payload";
import {
  decryptQueuedUserMessageRunParams,
  encryptQueuedUserMessageRunParams,
} from "../signals/services/zero-chat-queued-event.service";
import { createDeferredPromise, onRejection } from "../signals/utils";

/**
 * BDD-scoped vm0 managed key prefixes. Fixture writes below only ever touch
 * rows whose api_key carries one of these prefixes, so concurrent test files
 * cannot clobber real seed data or each other's non-bdd rows.
 */
const VM0_BDD_API_KEY_PREFIXES = [
  "vm0-key-bdd-fake-",
  "vm0-key-bdd-dev-seed-",
] as const;
const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });
const blockedByPidRowSchema = z.object({ blocked: z.boolean() });
const blockedQueryRowSchema = z.object({ query: z.string() });

type ChatThreadBlockedStatementKind = "select_for_update" | "update" | "other";

interface ChatEventInputParamsFixture {
  readonly eventId: string;
  readonly encryptedParams: string;
}

interface ChatEventContextFixture {
  readonly id: string;
  readonly revokesEventId: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly automationId: string | null;
  readonly triggerBrief: string | null;
  readonly workflowName: string | null;
  readonly workflowEventType: string | null;
  readonly workflowEventPayload: JsonObject | null;
  readonly slackPermalink: string | null;
  readonly slackChannelId: string | null;
  readonly slackMessageTs: string | null;
  readonly slackConversationContext: string | null;
  readonly slackMessageText: string | null;
  readonly slackMessageFiles: ChatSlackMessageFiles | null;
  readonly slackMentionDisplayNames: ChatSlackMentionDisplayNames | null;
  readonly slackSenderDisplayName: string | null;
  readonly slackSenderUserId: string | null;
  readonly slackChannelType: "channel" | "dm" | "group_dm" | null;
  readonly slackThreadTs: string | null;
  readonly slackRouteThreadTs: string | null;
  readonly feishuOpenUrl: string | null;
  readonly feishuConversationHistory: string | null;
  readonly feishuMessageText: string | null;
  readonly feishuMessageFiles: ChatFeishuMessageFiles | null;
  readonly feishuChatType: "group" | "p2p" | "topic_group" | null;
  readonly feishuChatId: string | null;
  readonly feishuMessageId: string | null;
  readonly feishuThreadId: string | null;
  readonly feishuReplyInThread: boolean | null;
  readonly feishuReactionId: string | null;
  readonly feishuSenderOpenId: string | null;
  readonly feishuConnectionId: string | null;
  readonly feishuInstallationId: string | null;
  readonly teamsTenantId: string | null;
  readonly teamsTeamId: string | null;
  readonly teamsChannelId: string | null;
  readonly teamsConversationId: string | null;
  readonly teamsConversationType: string | null;
  readonly teamsActivityId: string | null;
  readonly teamsThreadContext: string | null;
  readonly teamsMessageText: string | null;
  readonly teamsMessageFiles: ChatTeamsMessageFiles | null;
  readonly teamsTenantName: string | null;
  readonly teamsTeamName: string | null;
  readonly teamsThreadId: string | null;
  readonly teamsServiceUrl: string | null;
  readonly teamsAppId: string | null;
  readonly teamsBotId: string | null;
  readonly teamsBotName: string | null;
  readonly teamsSenderUserId: string | null;
  readonly teamsSenderDisplayName: string | null;
  readonly teamsSenderPrincipalName: string | null;
  readonly teamsConnectionId: string | null;
  readonly agentphoneChatThreadId: string | null;
  readonly agentphoneMessageText: string | null;
  readonly agentphoneThreadContext: string | null;
  readonly agentphoneMessageId: string | null;
  readonly agentphoneRootMessageId: string | null;
  readonly agentphoneConversationId: string | null;
  readonly agentphoneChannel: "imessage" | "sms" | "mms" | null;
  readonly agentphoneIsGroup: boolean | null;
  readonly agentphonePhoneHandle: string | null;
  readonly agentphoneFromNumber: string | null;
  readonly agentphoneToNumber: string | null;
  readonly agentphoneUserLinkId: string | null;
  readonly agentphoneAgentId: string | null;
  readonly telegramChatId: string | null;
  readonly telegramMessageId: string | null;
  readonly telegramIsDm: boolean | null;
  readonly githubRepo: string | null;
  readonly githubSubjectNumber: number | null;
  readonly githubSubjectKind: "issue" | "pull_request" | null;
  readonly githubTriggerCommentId: string | null;
  readonly githubIssueContext: string | null;
  readonly githubMessageText: string | null;
  readonly githubTriggerReactionId: string | null;
  readonly githubTriggerCommentBody: string | null;
  readonly morningBriefDeliveryId: string | null;
  readonly morningBriefTimezone: string | null;
  readonly morningBriefTriggeredAt: Date | null;
  readonly goalObjectiveBrief: string | null;
}

export async function readChatEventContextFixture(
  eventId: string,
): Promise<ChatEventContextFixture | null> {
  const contextId = sql`COALESCE(${chatEvents.contextId}, ${chatEvents.id})`;
  const [event] = await db()
    .select({
      id: chatEvents.id,
      revokesEventId: chatEvents.revokesEventId,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      automationId: chatAutomationContext.automationId,
      triggerBrief: chatAutomationContext.triggerBrief,
      workflowName: chatAutomationContext.workflowName,
      workflowEventType: chatAutomationContext.eventType,
      workflowEventPayload: chatAutomationContext.eventPayload,
      slackPermalink: chatSlackContext.messagePermalink,
      slackChannelId: chatSlackContext.channelId,
      slackMessageTs: chatSlackContext.messageTs,
      slackConversationContext: chatSlackContext.conversationContext,
      slackMessageText: chatSlackContext.messageText,
      slackMessageFiles: chatSlackContext.messageFiles,
      slackMentionDisplayNames: chatSlackContext.mentionDisplayNames,
      slackSenderDisplayName: chatSlackContext.senderDisplayName,
      slackSenderUserId: chatSlackContext.senderUserId,
      slackChannelType: chatSlackContext.channelType,
      slackThreadTs: chatSlackContext.threadTs,
      slackRouteThreadTs: chatSlackContext.routeThreadTs,
      feishuOpenUrl: chatFeishuContext.chatOpenUrl,
      feishuConversationHistory: chatFeishuContext.conversationHistory,
      feishuMessageText: chatFeishuContext.messageText,
      feishuMessageFiles: chatFeishuContext.messageFiles,
      feishuChatType: chatFeishuContext.chatType,
      feishuChatId: chatFeishuContext.chatId,
      feishuMessageId: chatFeishuContext.messageId,
      feishuThreadId: chatFeishuContext.threadId,
      feishuReplyInThread: chatFeishuContext.replyInThread,
      feishuReactionId: chatFeishuContext.reactionId,
      feishuSenderOpenId: chatFeishuContext.senderOpenId,
      feishuConnectionId: chatFeishuContext.connectionId,
      feishuInstallationId: chatFeishuContext.installationId,
      teamsTenantId: chatTeamsContext.tenantId,
      teamsTeamId: chatTeamsContext.teamId,
      teamsChannelId: chatTeamsContext.channelId,
      teamsConversationId: chatTeamsContext.conversationId,
      teamsConversationType: chatTeamsContext.conversationType,
      teamsActivityId: chatTeamsContext.activityId,
      teamsThreadContext: chatTeamsContext.threadContext,
      teamsMessageText: chatTeamsContext.messageText,
      teamsMessageFiles: chatTeamsContext.messageFiles,
      teamsTenantName: chatTeamsContext.tenantName,
      teamsTeamName: chatTeamsContext.teamName,
      teamsThreadId: chatTeamsContext.threadId,
      teamsServiceUrl: chatTeamsContext.serviceUrl,
      teamsAppId: chatTeamsContext.teamsAppId,
      teamsBotId: chatTeamsContext.botId,
      teamsBotName: chatTeamsContext.botName,
      teamsSenderUserId: chatTeamsContext.senderUserId,
      teamsSenderDisplayName: chatTeamsContext.senderDisplayName,
      teamsSenderPrincipalName: chatTeamsContext.senderPrincipalName,
      teamsConnectionId: chatTeamsContext.connectionId,
      agentphoneChatThreadId: chatAgentphoneContext.chatThreadId,
      agentphoneMessageText: chatAgentphoneContext.messageText,
      agentphoneThreadContext: chatAgentphoneContext.threadContext,
      agentphoneMessageId: chatAgentphoneContext.messageId,
      agentphoneRootMessageId: chatAgentphoneContext.rootMessageId,
      agentphoneConversationId: chatAgentphoneContext.conversationId,
      agentphoneChannel: chatAgentphoneContext.channel,
      agentphoneIsGroup: chatAgentphoneContext.isGroup,
      agentphonePhoneHandle: chatAgentphoneContext.phoneHandle,
      agentphoneFromNumber: chatAgentphoneContext.fromNumber,
      agentphoneToNumber: chatAgentphoneContext.toNumber,
      agentphoneUserLinkId: chatAgentphoneContext.userLinkId,
      agentphoneAgentId: chatAgentphoneContext.agentphoneAgentId,
      telegramChatId: chatTelegramContext.chatId,
      telegramMessageId: chatTelegramContext.messageId,
      telegramIsDm: chatTelegramContext.isDm,
      githubRepo: chatGithubContext.repo,
      githubSubjectNumber: chatGithubContext.subjectNumber,
      githubSubjectKind: chatGithubContext.subjectKind,
      githubTriggerCommentId: chatGithubContext.triggerCommentId,
      githubIssueContext: chatGithubContext.issueContext,
      githubMessageText: chatGithubContext.messageText,
      githubTriggerReactionId: chatGithubContext.triggerReactionId,
      githubTriggerCommentBody: chatGithubContext.triggerCommentBody,
      morningBriefDeliveryId: chatMorningBriefContext.deliveryId,
      morningBriefTimezone: chatMorningBriefContext.timezone,
      morningBriefTriggeredAt: chatMorningBriefContext.triggeredAt,
      goalObjectiveBrief: chatGoalContext.objectiveBrief,
    })
    .from(chatEvents)
    .leftJoin(chatAutomationContext, eq(chatAutomationContext.id, contextId))
    .leftJoin(chatSlackContext, eq(chatSlackContext.id, contextId))
    .leftJoin(chatFeishuContext, eq(chatFeishuContext.id, contextId))
    .leftJoin(chatTeamsContext, eq(chatTeamsContext.id, contextId))
    .leftJoin(chatAgentphoneContext, eq(chatAgentphoneContext.id, contextId))
    .leftJoin(chatTelegramContext, eq(chatTelegramContext.id, contextId))
    .leftJoin(chatGithubContext, eq(chatGithubContext.id, contextId))
    .leftJoin(
      chatMorningBriefContext,
      eq(chatMorningBriefContext.id, contextId),
    )
    .leftJoin(chatGoalContext, eq(chatGoalContext.id, contextId))
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  return event ?? null;
}

const annotationProjectionInputs = [
  {
    text: "slack linked",
    triggerSource: "slack",
    context: {
      slackContext: {
        messagePermalink:
          "https://vm0.slack.com/archives/C123/p1753257600000100",
        channelId: "C123",
        messageTs: "1753257600.000100",
        conversationContext: "",
        messageText: "slack linked",
        messageFiles: [],
        mentionDisplayNames: {},
        senderDisplayName: "Slack User",
        senderUserId: "U123",
        channelType: "channel",
        threadTs: "1753257600.000100",
        routeThreadTs: null,
      },
    },
  },
  {
    text: "feishu linked",
    triggerSource: "feishu",
    context: {
      feishuContext: {
        chatOpenUrl:
          "https://applink.feishu.cn/client/chat/open?openChatId=oc_123",
        conversationHistory: "",
        messageText: "feishu linked",
        messageFiles: [],
        chatType: "p2p",
        chatId: "oc_123",
        messageId: "om_123",
        threadId: "om_123",
        replyInThread: false,
        reactionId: null,
        senderOpenId: "ou_123",
        connectionId: "00000000-0000-4000-8000-000000000001",
        installationId: "00000000-0000-4000-8000-000000000002",
      },
    },
  },
  {
    text: "teams channel linked",
    triggerSource: "teams",
    context: {
      teamsContext: {
        tenantId: "tenant-1",
        teamId: "team-1",
        channelId: "19:channel@thread.tacv2",
        conversationId: "19:conversation@thread.tacv2",
        conversationType: "channel",
        activityId: "activity-1",
        threadContext: "",
        messageText: "teams channel linked",
        messageFiles: [],
        tenantName: "Tenant One",
        teamName: "Team One",
        threadId: "activity-1",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        teamsAppId: "teams-app-1",
        botId: "28:bot-1",
        botName: "Okou",
        senderUserId: "29:user-1",
        senderDisplayName: "Ada Lovelace",
        senderPrincipalName: "ada@example.com",
        connectionId: "00000000-0000-4000-8000-000000000003",
      },
    },
  },
  {
    text: "teams personal unlinked",
    triggerSource: "teams",
    context: {
      teamsContext: {
        tenantId: "tenant-1",
        teamId: null,
        channelId: null,
        conversationId: "a:personal-conversation",
        conversationType: "personal",
        activityId: "activity-dm",
        threadContext: "",
        messageText: "teams personal unlinked",
        messageFiles: [],
        tenantName: "Tenant One",
        teamName: null,
        threadId: "direct-message:agent-1:default",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        teamsAppId: "teams-app-1",
        botId: null,
        botName: null,
        senderUserId: "29:user-1",
        senderDisplayName: null,
        senderPrincipalName: null,
        connectionId: "00000000-0000-4000-8000-000000000003",
      },
    },
  },
  {
    text: "telegram supergroup linked",
    triggerSource: "telegram",
    context: {
      telegramContext: {
        chatId: "-1001234567890",
        messageId: "42",
        isDm: false,
        messageThreadId: 7,
      },
    },
  },
  {
    text: "telegram dm unlinked",
    triggerSource: "telegram",
    context: {
      telegramContext: {
        chatId: "123456789",
        messageId: "43",
        isDm: true,
        messageThreadId: null,
      },
    },
  },
  {
    text: "telegram group unlinked",
    triggerSource: "telegram",
    context: {
      telegramContext: {
        chatId: "-123456789",
        messageId: "44",
        isDm: false,
        messageThreadId: null,
      },
    },
  },
  {
    text: "github issue comment linked",
    triggerSource: "github",
    context: {
      githubContext: {
        repo: "vm0-ai/vm0",
        subjectNumber: 24_218,
        subjectKind: "issue",
        triggerCommentId: "123456",
        issueContext: "",
        messageText: "github issue comment linked",
        triggerReactionId: null,
        triggerCommentBody: null,
      },
    },
  },
  {
    text: "github pull request linked",
    triggerSource: "github",
    context: {
      githubContext: {
        repo: "vm0-ai/vm0",
        subjectNumber: 24_219,
        subjectKind: "pull_request",
        triggerCommentId: null,
        issueContext: "",
        messageText: "github pull request linked",
        triggerReactionId: null,
        triggerCommentBody: null,
      },
    },
  },
] as const;

function annotationProjectionSourcePart(
  input: (typeof annotationProjectionInputs)[number],
) {
  if ("slackContext" in input.context) {
    return createChatEventSourcePart({
      kind: "slack",
      messagePermalink: input.context.slackContext.messagePermalink,
    });
  }
  if ("feishuContext" in input.context) {
    return createChatEventSourcePart({
      kind: "feishu",
      chatOpenUrl: input.context.feishuContext.chatOpenUrl,
    });
  }
  if ("teamsContext" in input.context) {
    return createChatEventSourcePart({
      kind: "teams",
      tenantId: input.context.teamsContext.tenantId,
      channelId: input.context.teamsContext.channelId,
      activityId: input.context.teamsContext.activityId,
    });
  }
  if ("telegramContext" in input.context) {
    return createChatEventSourcePart({
      kind: "telegram",
      chatId: input.context.telegramContext.chatId,
      messageId: input.context.telegramContext.messageId,
      isDm: input.context.telegramContext.isDm,
    });
  }
  return createChatEventSourcePart({
    kind: "github",
    repo: input.context.githubContext.repo,
    subjectNumber: input.context.githubContext.subjectNumber,
    subjectKind: input.context.githubContext.subjectKind,
    triggerCommentId: input.context.githubContext.triggerCommentId,
  });
}

export async function seedChatEventAnnotationProjectionFixture(
  chatThreadId: string,
): Promise<{
  readonly claimedPendingId: string;
  readonly rejectedPendingId: string;
}> {
  const claimedPendingId = randomUUID();
  const rejectedPendingId = randomUUID();
  await db().transaction(async (tx) => {
    for (const input of annotationProjectionInputs) {
      await insertChatEvent(tx, {
        chatThreadId,
        eventType: "input.prompt",
        userMessage: createUserMessageDocument({
          text: input.text,
          nonContentPart: annotationProjectionSourcePart(input),
        }),
        runId: null,
        triggerSource: input.triggerSource,
        ...input.context,
      });
    }

    await insertChatEvent(tx, {
      id: claimedPendingId,
      chatThreadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({
        text: "claimed annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "github",
          repo: "vm0-ai/vm0",
          subjectNumber: 24_218,
          subjectKind: "issue",
          triggerCommentId: "654321",
        }),
      }),
      runId: null,
      triggerSource: "github",
      githubContext: {
        repo: "vm0-ai/vm0",
        subjectNumber: 24_218,
        subjectKind: "issue",
        triggerCommentId: "654321",
        issueContext: "",
        messageText: "claimed annotation",
        triggerReactionId: null,
        triggerCommentBody: null,
      },
    });
    await replaceChatEvent(tx, claimedPendingId, {
      chatThreadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({
        text: "claimed annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "github",
          repo: "vm0-ai/vm0",
          subjectNumber: 24_218,
          subjectKind: "issue",
          triggerCommentId: "654321",
        }),
      }),
      runId: randomUUID(),
      triggerSource: "github",
    });

    await insertChatEvent(tx, {
      id: rejectedPendingId,
      chatThreadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({
        text: "rejected annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "teams",
          tenantId: "tenant-2",
          channelId: "19:reject@thread.tacv2",
          activityId: "activity-rejected",
        }),
      }),
      runId: null,
      triggerSource: "teams",
      teamsContext: {
        tenantId: "tenant-2",
        teamId: "team-2",
        channelId: "19:reject@thread.tacv2",
        conversationId: "19:reject-conversation@thread.tacv2",
        conversationType: "channel",
        activityId: "activity-rejected",
        threadContext: "",
        messageText: "rejected annotation",
        messageFiles: [],
        tenantName: "Tenant Two",
        teamName: "Team Two",
        threadId: "activity-rejected",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        teamsAppId: "teams-app-2",
        botId: "28:bot-2",
        botName: "Okou",
        senderUserId: "29:user-2",
        senderDisplayName: "Grace Hopper",
        senderPrincipalName: "grace@example.com",
        connectionId: "00000000-0000-4000-8000-000000000004",
      },
    });
    await replaceChatEvent(tx, rejectedPendingId, {
      chatThreadId,
      eventType: "input.rejected",
      userMessage: createUserMessageDocument({
        text: "rejected annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "teams",
          tenantId: "tenant-2",
          channelId: "19:reject@thread.tacv2",
          activityId: "activity-rejected",
        }),
      }),
      runId: null,
      error: "rejected for annotation coverage",
      triggerSource: "teams",
    });
  });
  return { claimedPendingId, rejectedPendingId };
}

export async function readChatEventInputParamsFixture(
  eventId: string,
): Promise<ChatEventInputParamsFixture | null> {
  const [row] = await db()
    .select({
      eventId: chatEventInputParams.eventId,
      encryptedParams: chatEventInputParams.encryptedParams,
    })
    .from(chatEventInputParams)
    .where(eq(chatEventInputParams.eventId, eventId))
    .limit(1);
  return row ?? null;
}

export async function decryptChatEventInputParamsFixture(
  eventId: string,
  ctx: { readonly orgId: string; readonly userId: string },
) {
  const row = await readChatEventInputParamsFixture(eventId);
  if (!row) {
    return null;
  }
  return await decryptQueuedUserMessageRunParams(row.encryptedParams, ctx);
}

export async function replaceGitHubLaunchMaterialWithLegacyParamsFixture(
  eventId: string,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly prompt: string;
    readonly appendSystemPrompt: string;
    readonly githubDelivery: GitHubDeliveryTarget;
  },
): Promise<void> {
  const [event] = await db()
    .select({ contextId: chatEvents.contextId })
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  if (!event?.contextId) {
    throw new Error("Expected pending GitHub event context");
  }
  const contextId = event.contextId;
  const encryptedParams = await encryptQueuedUserMessageRunParams(
    {
      version: 1,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
      githubDelivery: args.githubDelivery,
    },
    { orgId: args.orgId, userId: args.userId },
  );
  await db().transaction(async (tx) => {
    await tx
      .update(chatGithubContext)
      .set({
        issueContext: null,
        messageText: null,
        triggerReactionId: null,
        triggerCommentBody: null,
      })
      .where(eq(chatGithubContext.id, contextId));
    await tx
      .update(chatEventInputParams)
      .set({ encryptedParams })
      .where(eq(chatEventInputParams.eventId, eventId));
  });
}

export async function clearGitHubTriggerCommentBodyFixture(
  eventId: string,
): Promise<void> {
  const [event] = await db()
    .select({ contextId: chatEvents.contextId })
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  if (!event?.contextId) {
    throw new Error("Expected pending GitHub event context");
  }
  await db()
    .update(chatGithubContext)
    .set({ triggerCommentBody: null })
    .where(eq(chatGithubContext.id, event.contextId));
}

export async function findPendingChatEventInputParamsByPromptFixture(
  prompt: string,
): Promise<ChatEventInputParamsFixture | null> {
  const rows = await db()
    .select({
      eventId: chatEventInputParams.eventId,
      encryptedParams: chatEventInputParams.encryptedParams,
      userMessage: chatEvents.userMessage,
    })
    .from(chatEventInputParams)
    .innerJoin(chatEvents, eq(chatEvents.id, chatEventInputParams.eventId))
    .where(isNull(chatEvents.runId));
  const row = rows.find((candidate) => {
    return candidate.userMessage?.parts.some((part) => {
      return part.type === "text" && part.text === prompt;
    });
  });
  return row ?? null;
}

/**
 * Makes one pending queue item fail while loading its private run parameters.
 * Product APIs cannot persist malformed encrypted state.
 */
export async function invalidatePendingChatEventInputParamsFixture(
  eventId: string,
): Promise<void> {
  const rows = await db()
    .insert(chatEventInputParams)
    .values({
      eventId,
      encryptedParams: "invalid-encrypted-queue-params",
    })
    .onConflictDoUpdate({
      target: chatEventInputParams.eventId,
      set: { encryptedParams: "invalid-encrypted-queue-params" },
    })
    .returning({ eventId: chatEventInputParams.eventId });
  if (rows.length !== 1) {
    throw new Error("Expected one pending queue item to become invalid");
  }
}

export async function replayPendingChatInputQueueEventFixture(args: {
  readonly eventId: string;
  readonly replacementId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [event] = await tx
      .select({
        chatThreadId: chatEvents.chatThreadId,
        userMessage: chatEvents.userMessage,
        attachFiles: chatEvents.attachFiles,
        generationTemplate: chatEvents.generationTemplate,
        triggerSource: chatEvents.triggerSource,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .limit(1);
    if (!event?.userMessage) {
      throw new Error("Expected one pending chat input queue event");
    }
    const replacement = await replaceChatEvent(tx, args.eventId, {
      id: args.replacementId,
      chatThreadId: event.chatThreadId,
      eventType: "input.prompt",
      userMessage: event.userMessage,
      runId: null,
      attachFiles: event.attachFiles ? [...event.attachFiles] : null,
      generationTemplate: event.generationTemplate,
      ...(event.triggerSource ? { triggerSource: event.triggerSource } : {}),
    });
    if (!replacement) {
      throw new Error("Expected the pending queue event replay to insert");
    }
  });
}

/**
 * Move one exact workflow event into historical state without waiting for real
 * time to pass. A string preserves PostgreSQL precision beyond JavaScript
 * milliseconds. Product APIs cannot construct an already-stale queue item.
 */
export async function setWorkflowQueueEventCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date | string;
}): Promise<void> {
  const createdAt =
    typeof args.createdAt === "string"
      ? sql`CAST(${args.createdAt} AS timestamp)`
      : args.createdAt;
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.automation"),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one workflow queue event to become historical");
  }
}

/**
 * Move one exact queued web message into historical state without waiting for
 * real time to pass. Product APIs cannot construct an already-stale queue item.
 */
export async function setQueuedUserMessageCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt: args.createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one queued user message to become historical");
  }
}

/**
 * Complete one claimed run without dispatching its terminal callbacks. This
 * reproduces the missed-callback state that the stale queue sweep recovers.
 */
export async function completeRunWithoutCallbacksFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const completedAt = nowDate();
  const updated = await db()
    .update(agentRuns)
    .set({ status: "completed", completedAt })
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one running run to complete without callbacks");
  }
}

/**
 * Holds checkpoint reads after `/complete` has loaded its run but before its
 * terminal compare-and-set. Product APIs cannot pause at this race boundary.
 */
export async function holdCheckpointReadsFixture(args: {
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the checkpoint lock holder pid");
    }
    await tx.execute(sql`LOCK TABLE ${checkpoints} IN ACCESS EXCLUSIVE MODE`);
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Reproduces a crash after the canonical chat callback was acknowledged but
 * before its detached terminal processing became durable. Product APIs cannot
 * delete append-only events, so this fixture removes only the exact cancelled
 * lifecycle row after verifying that the chat callback is already delivered.
 */
export async function removeAcknowledgedCancellationLifecycleFixture(args: {
  readonly runId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [callback] = await tx
      .select({ status: agentRunCallbacks.status })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, args.runId),
          eq(agentRunCallbacks.internalKind, "chat"),
        ),
      )
      .limit(1);
    if (callback?.status !== "delivered") {
      throw new Error("Expected an acknowledged canonical chat callback");
    }

    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    const removed = await tx
      .delete(chatEvents)
      .where(
        and(
          eq(chatEvents.runId, args.runId),
          eq(chatEvents.eventType, "run.cancelled"),
        ),
      )
      .returning({ id: chatEvents.id });
    if (removed.length !== 1) {
      throw new Error("Expected one cancelled lifecycle event");
    }
  });
}

async function transitiveBlockedWaiterCount(
  holderPid: number,
): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      WITH RECURSIVE blocked("pid") AS (
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))

        UNION

        SELECT activity.pid
        FROM pg_stat_activity AS activity
        INNER JOIN blocked AS blocker
          ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT ${count()}::int AS "waiterCount"
      FROM blocked
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

async function directBlockedWaiterCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

async function firstDirectBlockedStatementKind(
  holderPid: number,
): Promise<ChatThreadBlockedStatementKind | null> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT activity.query AS "query"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
      ORDER BY activity.query_start, activity.pid
      LIMIT 1
    `,
    blockedQueryRowSchema,
  );
  const query = rows[0]?.query.toLowerCase().replaceAll(/\s+/g, " ").trim();
  if (!query) {
    return null;
  }
  if (
    query.startsWith("select") &&
    query.includes('from "chat_threads"') &&
    query.includes("for update")
  ) {
    return "select_for_update";
  }
  if (query.startsWith('update "chat_threads"')) {
    return "update";
  }
  return "other";
}

/**
 * Holds one thread row so route tests can observe the first product statement
 * that requires a write-oriented lock. Product APIs cannot pause at this
 * boundary, and the fixture does not change the held row.
 */
export async function holdChatThreadRowLockFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly firstBlockedStatementKind: () => Promise<ChatThreadBlockedStatementKind | null>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new Error("Expected the chat thread row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat thread lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    firstBlockedStatementKind: async () => {
      return await firstDirectBlockedStatementKind(holderPid);
    },
  };
}

async function pidIsBlocked(waiterPid: number): Promise<boolean> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT cardinality(pg_blocking_pids(${waiterPid})) > 0 AS "blocked"
    `,
    blockedByPidRowSchema,
  );
  return rows[0]?.blocked ?? false;
}

function bddVm0ApiKeyFilter(vendor: string, model: string) {
  const [fakePrefix, devSeedPrefix] = VM0_BDD_API_KEY_PREFIXES;
  return and(
    eq(vm0ApiKeys.vendor, vendor),
    eq(vm0ApiKeys.model, model),
    or(
      like(vm0ApiKeys.apiKey, `${fakePrefix}%`),
      like(vm0ApiKeys.apiKey, `${devSeedPrefix}%`),
    ),
  );
}

/**
 * Replaces the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model.
 *
 * Why product APIs cannot construct this state: vm0_api_keys is a
 * platform-operations table with no product write surface — keys are
 * provisioned out of band. Keys passed here must carry a
 * VM0_BDD_API_KEY_PREFIXES prefix so only bdd rows are touched.
 */
export async function replaceBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
  readonly keys: readonly { readonly apiKey: string; readonly label: string }[];
}): Promise<void> {
  for (const key of args.keys) {
    const scoped = VM0_BDD_API_KEY_PREFIXES.some((prefix) => {
      return key.apiKey.length > prefix.length && key.apiKey.startsWith(prefix);
    });
    if (!scoped) {
      throw new Error(
        `replaceBddVm0ApiKeys: api key must start with one of ${VM0_BDD_API_KEY_PREFIXES.join(", ")}`,
      );
    }
  }
  await db().transaction(async (tx) => {
    await tx
      .delete(vm0ApiKeys)
      .where(bddVm0ApiKeyFilter(args.vendor, args.model));
    if (args.keys.length > 0) {
      await tx.insert(vm0ApiKeys).values(
        args.keys.map((key) => {
          return {
            vendor: args.vendor,
            model: args.model,
            apiKey: key.apiKey,
            label: key.label,
          };
        }),
      );
    }
  });
}

/**
 * Deletes the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model. See replaceBddVm0ApiKeys for why no product API exists.
 */
export async function deleteBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
}): Promise<void> {
  await db()
    .delete(vm0ApiKeys)
    .where(bddVm0ApiKeyFilter(args.vendor, args.model));
}

/**
 * Checks the operator-managed label for a key returned through a public test
 * entry point. The key pool has no product read surface, and local dev seeds
 * may contain additional valid keys for the same vendor and model.
 */
export async function hasVm0ApiKeyLabel(args: {
  readonly vendor: string;
  readonly model: string;
  readonly apiKey: string;
  readonly label: string;
}): Promise<boolean> {
  const rows = await db()
    .select({ id: vm0ApiKeys.id })
    .from(vm0ApiKeys)
    .where(
      and(
        eq(vm0ApiKeys.vendor, args.vendor),
        eq(vm0ApiKeys.model, args.model),
        eq(vm0ApiKeys.apiKey, args.apiKey),
        eq(vm0ApiKeys.label, args.label),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

/**
 * Holds the production org admission advisory lock and reports its waiter
 * count. No product API exposes database lock timing, so this fixture is the
 * narrow boundary exception for the queue-drain concurrency test.
 */
export async function holdOrgAdmissionLockFixture(args: {
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await executeRawRows(
      tx,
      sql`
        SELECT
          pg_backend_pid() AS "pid",
          pg_advisory_xact_lock(hashtext(${args.orgId}))
      `,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the admission lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    waiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'advisory'
            AND NOT waiting.granted
            AND (waiting.classid, waiting.objid, waiting.objsubid) IN (
              SELECT held.classid, held.objid, held.objsubid
              FROM pg_locks AS held
              WHERE held.locktype = 'advisory'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/**
 * Holds the workflow queue admission key so tests can observe concurrent
 * requests waiting on the per-thread lock.
 */
export async function holdChatEventQueueAdmissionLockFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly directWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const lockKey = `chat_event_queue:${args.threadId}`;
    const rows = await executeRawRows(
      tx,
      sql`
        SELECT
          pg_backend_pid() AS "pid",
          pg_advisory_xact_lock(hashtext(${lockKey}))
      `,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the queue admission lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    directWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Stages the canonical conversation clear inside an open transaction so a
 * concurrent run still resolves the pre-clear snapshot, then blocks on this
 * transaction when its launch commit re-reads the session row `FOR UPDATE`.
 *
 * Waiting on this transaction is a precise barrier for "the run captured its
 * snapshot and reached commit". Counting waiters on the org admission key is
 * not: the background queue drain takes that same key, so it can satisfy the
 * barrier before the run has resolved its session at all.
 */
export async function holdThreadSessionConversationClearFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .select({ agentSessionId: chatThreads.agentSessionId })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .limit(1);
    if (!thread?.agentSessionId) {
      throw new Error("Expected a bound chat thread session");
    }
    const [session] = await tx
      .update(agentSessions)
      .set({ conversationId: null })
      .where(eq(agentSessions.id, thread.agentSessionId))
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Expected a bound agent session");
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the conversation clear holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'transactionid'
            AND NOT waiting.granted
            AND waiting.transactionid IN (
              SELECT held.transactionid
              FROM pg_locks AS held
              WHERE held.locktype = 'transactionid'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/**
 * Replaces one canonical binding with an otherwise valid session/run pair.
 * Product APIs cannot bind a thread to another owner's session, so this is the
 * narrow state boundary for ownership-corruption coverage.
 */
export async function replaceThreadSessionBindingFixture(args: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly runId: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({
      agentSessionId: args.sessionId,
      agentSessionRunId: args.runId,
    })
    .where(eq(chatThreads.id, args.threadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat thread session binding to be replaced");
  }
}

/**
 * Stages a canonical binding clear after the queue-first message row is
 * visible. Starting this transaction earlier would block that row's parent FK
 * check; once the row exists, the uncommitted clear remains invisible to
 * resolution and blocks only final snapshot validation on the thread row.
 */
export async function holdThreadSessionBindingClearFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ agentSessionId: null, agentSessionRunId: null })
      .where(eq(chatThreads.id, args.threadId))
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Expected a bound chat thread session");
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the binding clear holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Deletes one completed run to reproduce retention cleanup of binding
 * provenance. No product endpoint exposes historical run deletion.
 */
export async function deleteAgentRunFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const deleted = await db()
    .delete(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .returning({ id: agentRuns.id });
  if (deleted.length !== 1) {
    throw new Error("Expected one agent run to be deleted");
  }
}

async function readBoundThreadSessionConversation(threadId: string): Promise<{
  readonly sessionId: string;
  readonly conversationId: string;
}> {
  const [boundSession] = await db()
    .select({
      id: agentSessions.id,
      conversationId: agentSessions.conversationId,
    })
    .from(chatThreads)
    .innerJoin(agentSessions, eq(agentSessions.id, chatThreads.agentSessionId))
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!boundSession?.conversationId) {
    throw new Error("Expected a bound chat thread conversation");
  }
  return {
    sessionId: boundSession.id,
    conversationId: boundSession.conversationId,
  };
}

async function holdThreadSessionConversationChangeStage(args: {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly index: number;
  readonly stageRequest: Promise<void>;
  readonly release: Promise<void>;
  readonly markQueued: (holderPid: number) => void;
  readonly markStaged: (holderPid: number) => void;
  readonly markReleased: (holderPid: number) => void;
}): Promise<void> {
  await args.stageRequest;
  const holderPid = await db().transaction(async (tx) => {
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const pid = rows[0]?.pid;
    if (!pid) {
      throw new Error("Expected the conversation change holder pid");
    }
    args.markQueued(pid);
    const [session] = await tx
      .update(agentSessions)
      .set({
        conversationId: args.index % 2 === 0 ? null : args.conversationId,
      })
      .where(eq(agentSessions.id, args.sessionId))
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Expected the bound agent session");
    }
    args.markStaged(pid);
    await args.release;
    return pid;
  });
  args.markReleased(holderPid);
}

async function waitForConversationChangeStages(
  stages: readonly Promise<void>[],
): Promise<void> {
  await Promise.all(stages);
}

/**
 * Alternates the bound session's conversation snapshot while consecutive run
 * preparations reach final admission. This is the timing boundary for proving
 * the retry limit without mocking the resolver or admission service.
 */
export async function holdThreadSessionConversationChangesFixture(args: {
  readonly threadId: string;
  readonly changeCount: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly queueNextChange: () => void;
  readonly release: () => void;
  readonly releaseAll: () => void;
  readonly done: Promise<void>;
  readonly stagedChangeCount: () => number;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly queuedChangeIsBlocked: () => Promise<boolean>;
}> {
  if (args.changeCount < 1) {
    throw new Error("Expected at least one conversation snapshot change");
  }
  const boundSession = await readBoundThreadSessionConversation(args.threadId);

  const firstStaged = createDeferredPromise<void>(args.signal);
  const releases = Array.from({ length: args.changeCount }, () => {
    return createDeferredPromise<void>(args.signal);
  });
  const stageRequests = Array.from({ length: args.changeCount }, () => {
    return createDeferredPromise<void>(args.signal);
  });
  const stagePids: (number | undefined)[] = Array.from({
    length: args.changeCount,
  });
  let currentHolderPid: number | null = null;
  let requestedChanges = 1;
  let lastQueuedIndex: number | null = null;
  let stagedChanges = 0;
  const firstStageRequest = stageRequests[0];
  if (!firstStageRequest) {
    throw new Error("Missing first conversation snapshot stage request");
  }
  firstStageRequest.resolve(undefined);
  const stages = stageRequests.map(async (stageRequest, index) => {
    const release = releases[index];
    if (!release) {
      throw new Error("Missing conversation snapshot release gate");
    }
    await holdThreadSessionConversationChangeStage({
      sessionId: boundSession.sessionId,
      conversationId: boundSession.conversationId,
      index,
      stageRequest: stageRequest.promise,
      release: release.promise,
      markQueued: (holderPid) => {
        stagePids[index] = holderPid;
      },
      markStaged: (holderPid) => {
        currentHolderPid = holderPid;
        stagedChanges = index + 1;
        if (!firstStaged.settled()) {
          firstStaged.resolve(undefined);
        }
      },
      markReleased: (holderPid) => {
        if (currentHolderPid === holderPid) {
          currentHolderPid = null;
        }
      },
    });
  });
  const done = onRejection(waitForConversationChangeStages(stages), (error) => {
    if (!firstStaged.settled()) {
      firstStaged.reject(error);
    }
  });
  await firstStaged.promise;

  return {
    queueNextChange: () => {
      const stageRequest = stageRequests[requestedChanges];
      if (!stageRequest) {
        throw new Error("No remaining conversation snapshot change to queue");
      }
      lastQueuedIndex = requestedChanges;
      requestedChanges += 1;
      stageRequest.resolve(undefined);
    },
    release: () => {
      const release = releases[stagedChanges - 1];
      if (release && !release.settled()) {
        release.resolve(undefined);
      }
    },
    releaseAll: () => {
      for (const stageRequest of stageRequests) {
        if (!stageRequest.settled()) {
          stageRequest.resolve(undefined);
        }
      }
      for (const release of releases) {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      }
    },
    done,
    stagedChangeCount: () => {
      return stagedChanges;
    },
    blockedWaiterCount: async () => {
      return currentHolderPid === null
        ? 0
        : await directBlockedWaiterCount(currentHolderPid);
    },
    queuedChangeIsBlocked: async () => {
      if (currentHolderPid === null || lastQueuedIndex === null) {
        return false;
      }
      const queuedPid = stagePids[lastQueuedIndex];
      if (!queuedPid || lastQueuedIndex < stagedChanges) {
        return false;
      }
      return await pidIsBlocked(queuedPid);
    },
  };
}

/**
 * Holds one pending chat input event so a claim and recall can reach the same
 * product lock in a test-owned order. This timing-only boundary neither creates
 * nor changes product rows and cannot block unrelated queue items.
 */
export async function holdChatEventQueueItemFixture(args: {
  readonly threadId: string;
  readonly eventId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly directBlockedWaiterCount: () => Promise<number>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .for("update")
      .limit(1);
    if (!pending) {
      throw new Error("Expected the pending chat input event");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message queue lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    directBlockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Holds one existing ChatEvent row so thread deletion can pause after it
 * owns the parent thread lock. This timing-only boundary does not create or
 * mutate product data and cannot block messages outside the selected thread.
 */
export async function holdChatEventFixture(args: {
  readonly threadId: string;
  readonly eventId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
        ),
      )
      .for("update")
      .limit(1);
    if (!rows[0]) {
      throw new Error("Expected the chat message row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Inserts one event through the production sequence writer, then holds its
 * transaction open. No product endpoint can pause between INSERT and COMMIT,
 * so this fixture is the narrow timing boundary for sequence serialization.
 */
export async function holdChatEventInsertTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly event: { readonly id: string; readonly seqId: number };
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<{
    readonly pid: number;
    readonly event: { readonly id: string; readonly seqId: number };
  }>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message insert holder pid");
    }
    const event = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "output.message",
      content: args.content,
      runId: null,
    });
    if (!event) {
      throw new Error("Expected the held chat-message insert");
    }
    started.resolve({ pid: holderPid, event });
    await released.promise;
  });
  const { pid, event } = await started.promise;

  return {
    event,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(pid);
    },
  };
}

/** Inserts one event with reservation and persistence in one transaction. */
export async function insertChatEventTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const event = await db().transaction(async (tx) => {
    return await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "output.message",
      content: args.content,
      runId: null,
    });
  });
  if (!event) {
    throw new Error("Expected the chat-message insert");
  }
  return event;
}

/**
 * Appends an explicit output event with a nullable compatibility payload owned
 * by a different ChatEvent leaf. Product writers intentionally
 * cannot create this divergent rollout shape; the fixture proves readers use
 * `event_type` as the semantic discriminator instead of legacy payload shape.
 */
export async function insertOutputEventWithConflictingLegacyPayloadFixture(args: {
  readonly threadId: string;
  readonly runId?: string;
  readonly content: string;
  readonly createdAt?: Date;
  readonly legacyPayload: "run.completed" | "usage.recorded";
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const event = await db().transaction(async (tx) => {
    const identity = {
      chatThreadId: args.threadId,
      eventType: "output.message" as const,
      content: args.content,
      runId: args.runId ?? null,
      createdAt: args.createdAt,
    };
    const lifecyclePayloadEvent = {
      ...identity,
      runLifecycleEvent: "completed",
    };
    const usagePayloadEvent = {
      ...identity,
      usagePayload: {
        version: 1 as const,
        totalCredits: 0,
        settledAt: (args.createdAt ?? nowDate()).toISOString(),
        breakdown: [],
      },
    };
    const inserted =
      args.legacyPayload === "run.completed"
        ? await insertChatEvent(tx, lifecyclePayloadEvent)
        : await insertChatEvent(tx, usagePayloadEvent);
    if (!inserted) {
      throw new Error("Expected the conflicting legacy-payload event insert");
    }
    return inserted;
  });
  return event;
}
