import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatTeamsContext } from "@vm0/db/schema/chat-teams-context";
import { teamsChatThreadRoutes } from "@vm0/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import { appendTeamsFilesToPrompt, buildTeamsPrompt } from "./teams-prompt";

export interface TeamsQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly teamsDelivery: TeamsDeliveryTarget;
  readonly userInfoExtras: {
    readonly teamsUserDisplayName?: string;
    readonly teamsUserPrincipalName?: string;
    readonly teamsUserId: string;
  };
}

type TeamsLaunchContextRow = Pick<
  typeof chatTeamsContext.$inferSelect,
  | "tenantId"
  | "tenantName"
  | "teamId"
  | "teamName"
  | "channelId"
  | "conversationId"
  | "conversationType"
  | "threadId"
  | "activityId"
  | "serviceUrl"
  | "teamsAppId"
  | "botId"
  | "botName"
  | "senderUserId"
  | "senderDisplayName"
  | "senderPrincipalName"
  | "connectionId"
  | "threadContext"
  | "messageText"
  | "messageFiles"
> & {
  readonly userMessage: typeof chatEvents.$inferSelect.userMessage;
  readonly installationBotId: string | null;
  readonly installationBotName: string | null;
};

function requiredTeamsLaunchContext(row: TeamsLaunchContextRow | undefined) {
  if (
    !row ||
    row.threadId === null ||
    row.serviceUrl === null ||
    row.senderUserId === null ||
    row.connectionId === null ||
    row.threadContext === null ||
    row.messageText === null ||
    row.messageFiles === null ||
    row.userMessage === null
  ) {
    return null;
  }
  return {
    ...row,
    threadId: row.threadId,
    serviceUrl: row.serviceUrl,
    senderUserId: row.senderUserId,
    connectionId: row.connectionId,
    threadContext: row.threadContext,
    messageText: row.messageText,
    messageFiles: row.messageFiles,
    userMessage: row.userMessage,
  };
}

async function loadTeamsLaunchContext(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      tenantId: chatTeamsContext.tenantId,
      tenantName: chatTeamsContext.tenantName,
      teamId: chatTeamsContext.teamId,
      teamName: chatTeamsContext.teamName,
      channelId: chatTeamsContext.channelId,
      conversationId: chatTeamsContext.conversationId,
      conversationType: chatTeamsContext.conversationType,
      threadId: chatTeamsContext.threadId,
      activityId: chatTeamsContext.activityId,
      serviceUrl: chatTeamsContext.serviceUrl,
      teamsAppId: chatTeamsContext.teamsAppId,
      botId: chatTeamsContext.botId,
      botName: chatTeamsContext.botName,
      senderUserId: chatTeamsContext.senderUserId,
      senderDisplayName: chatTeamsContext.senderDisplayName,
      senderPrincipalName: chatTeamsContext.senderPrincipalName,
      connectionId: chatTeamsContext.connectionId,
      threadContext: chatTeamsContext.threadContext,
      messageText: chatTeamsContext.messageText,
      messageFiles: chatTeamsContext.messageFiles,
      userMessage: chatEvents.userMessage,
      installationBotId: teamsOrgInstallations.botId,
      installationBotName: teamsOrgInstallations.botName,
    })
    .from(chatEvents)
    .innerJoin(
      chatTeamsContext,
      and(
        eq(chatTeamsContext.id, chatEvents.contextId),
        eq(chatTeamsContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      teamsChatThreadRoutes,
      and(
        eq(teamsChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(teamsChatThreadRoutes.connectionId, chatTeamsContext.connectionId),
        eq(
          teamsChatThreadRoutes.conversationId,
          chatTeamsContext.conversationId,
        ),
        eq(teamsChatThreadRoutes.threadId, chatTeamsContext.threadId),
        eq(teamsChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      teamsOrgConnections,
      and(
        eq(teamsOrgConnections.id, chatTeamsContext.connectionId),
        eq(teamsOrgConnections.teamsTenantId, chatTeamsContext.tenantId),
        eq(teamsOrgConnections.vm0UserId, args.userId),
      ),
    )
    .innerJoin(
      teamsOrgInstallations,
      and(
        eq(teamsOrgInstallations.teamsTenantId, chatTeamsContext.tenantId),
        eq(teamsOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "teams"),
        eq(chatEvents.triggerSource, "teams"),
      ),
    )
    .limit(1);
  return requiredTeamsLaunchContext(row);
}

function promptFiles(context: {
  readonly messageFiles: NonNullable<
    typeof chatTeamsContext.$inferSelect.messageFiles
  >;
  readonly userMessage: NonNullable<typeof chatEvents.$inferSelect.userMessage>;
}) {
  // messageFiles also retains fetched context files for delivery. Only the
  // current message's file parts belonged to the legacy agent prompt.
  const promptFileIds = new Set(
    context.userMessage.parts.flatMap((part) => {
      return part.type === "file" ? [part.fileId] : [];
    }),
  );
  return context.messageFiles.filter((file) => {
    return promptFileIds.has(file.fileId);
  });
}

function promptThreadId(context: {
  readonly conversationType: string | null;
  readonly threadId: string;
  readonly activityId: string | null;
}): string {
  if (
    context.conversationType === "personal" &&
    context.activityId &&
    context.threadId.startsWith("direct-message:")
  ) {
    return context.activityId;
  }
  return context.threadId;
}

export async function loadTeamsQueuedLaunchMaterial(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<TeamsQueuedLaunchMaterial | null> {
  const context = await loadTeamsLaunchContext(db, args);
  if (!context) {
    return null;
  }
  const botId = context.botId ?? context.installationBotId;
  const botName = context.botName ?? context.installationBotName;
  return {
    prompt: appendTeamsFilesToPrompt(context.messageText, promptFiles(context)),
    appendSystemPrompt: buildTeamsPrompt({
      tenantId: context.tenantId,
      tenantName: context.tenantName,
      teamId: context.teamId,
      teamName: context.teamName,
      channelId: context.channelId,
      conversationId: context.conversationId,
      conversationType: context.conversationType,
      threadId: promptThreadId(context),
      activityId: context.activityId,
      teamsAppId: context.teamsAppId,
      botId,
      botName,
      threadContext: context.threadContext,
    }),
    teamsDelivery: teamsDeliveryTargetSchema.parse({
      tenantId: context.tenantId,
      tenantName: context.tenantName,
      teamId: context.teamId,
      teamName: context.teamName,
      channelId: context.channelId,
      conversationId: context.conversationId,
      conversationType: context.conversationType,
      threadId: context.threadId,
      activityId: context.activityId,
      serviceUrl: context.serviceUrl,
      connectionId: context.connectionId,
      teamsUserId: context.senderUserId,
      teamsUserDisplayName: context.senderDisplayName,
      teamsUserPrincipalName: context.senderPrincipalName,
      botId,
      botName,
      files: context.messageFiles.map((file) => {
        return { fileId: file.fileId, ...file.payload };
      }),
    }),
    userInfoExtras: {
      ...(context.senderDisplayName
        ? { teamsUserDisplayName: context.senderDisplayName }
        : {}),
      ...(context.senderPrincipalName
        ? { teamsUserPrincipalName: context.senderPrincipalName }
        : {}),
      teamsUserId: context.senderUserId,
    },
  };
}
