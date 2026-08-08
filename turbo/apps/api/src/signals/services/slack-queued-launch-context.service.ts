import {
  chatEvents,
  type ChatEventUserMessage,
} from "@vm0/db/schema/chat-event";
import { chatSlackContext } from "@vm0/db/schema/chat-slack-context";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import {
  buildSlackSystemPrompt,
  canonicalSlackAgentPrompt,
  resolveUserMentions,
  type SlackPromptAsset,
} from "../../lib/slack-webhook-context";
import { inferMimetype } from "../../lib/mimetype";
import type { SlackUserInfo } from "../external/slack-message-client";
import type { Db } from "../external/db";
import { userMessageFileParts } from "./zero-chat-user-message.service";

export interface SlackQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly slackDelivery: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly userInfoExtras?: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
  };
}

type SlackLaunchContextRow = Pick<
  typeof chatSlackContext.$inferSelect,
  | "channelId"
  | "conversationContext"
  | "messageText"
  | "messageFiles"
  | "mentionDisplayNames"
  | "senderDisplayName"
  | "senderUserId"
  | "channelType"
  | "threadTs"
  | "routeThreadTs"
> & {
  readonly botUserId: string;
  readonly userMessage: ChatEventUserMessage | null;
};

function requiredSlackLaunchContext(row: SlackLaunchContextRow | undefined) {
  if (
    !row ||
    row.channelId === null ||
    row.conversationContext === null ||
    row.messageText === null ||
    row.messageFiles === null ||
    row.mentionDisplayNames === null ||
    row.channelType === null ||
    row.threadTs === null ||
    row.userMessage === null
  ) {
    return null;
  }
  return {
    ...row,
    userMessage: row.userMessage,
    channelId: row.channelId,
    conversationContext: row.conversationContext,
    messageText: row.messageText,
    messageFiles: row.messageFiles,
    mentionDisplayNames: row.mentionDisplayNames,
    channelType: row.channelType,
    threadTs: row.threadTs,
  };
}

async function loadSlackLaunchContext(
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
      botUserId: slackOrgInstallations.botUserId,
      userMessage: chatEvents.userMessage,
      channelId: chatSlackContext.channelId,
      conversationContext: chatSlackContext.conversationContext,
      messageText: chatSlackContext.messageText,
      messageFiles: chatSlackContext.messageFiles,
      mentionDisplayNames: chatSlackContext.mentionDisplayNames,
      senderDisplayName: chatSlackContext.senderDisplayName,
      senderUserId: chatSlackContext.senderUserId,
      channelType: chatSlackContext.channelType,
      threadTs: chatSlackContext.threadTs,
      routeThreadTs: chatSlackContext.routeThreadTs,
    })
    .from(chatEvents)
    .innerJoin(
      chatSlackContext,
      and(
        eq(chatSlackContext.id, chatEvents.contextId),
        eq(chatSlackContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      slackChatThreadRoutes,
      and(
        eq(slackChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(slackChatThreadRoutes.channelId, chatSlackContext.channelId),
        or(
          and(
            isNull(chatSlackContext.routeThreadTs),
            eq(slackChatThreadRoutes.threadTs, chatSlackContext.threadTs),
          ),
          eq(slackChatThreadRoutes.threadTs, chatSlackContext.routeThreadTs),
        ),
        eq(slackChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
        eq(slackOrgConnections.vm0UserId, args.userId),
      ),
    )
    .innerJoin(
      slackOrgInstallations,
      and(
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
        eq(slackOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "slack"),
      ),
    )
    .limit(1);
  return requiredSlackLaunchContext(row);
}

/**
 * Resolve the canonical input assets the Slack message persisted in its user
 * message document. The document is the only ownership record: the file parts
 * name the assets, and the asset row carries the Slack file ID that pairs each
 * one back to the raw file retained with the launch context.
 */
async function loadSlackPromptAssets(
  db: Db,
  args: {
    readonly userMessage: ChatEventUserMessage;
    readonly userId: string;
  },
): Promise<SlackPromptAsset[]> {
  const assetIds = userMessageFileParts(args.userMessage).map((part) => {
    return part.fileId;
  });
  if (assetIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      assetId: runUploadedFiles.id,
      slackFileId: runUploadedFiles.externalId,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      status: runUploadedFiles.materializationStatus,
    })
    .from(runUploadedFiles)
    .where(
      and(
        inArray(runUploadedFiles.id, assetIds),
        eq(runUploadedFiles.userId, args.userId),
        eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
        eq(runUploadedFiles.classification, "input"),
      ),
    );
  return rows.map((row) => {
    const filename = row.filename ?? row.assetId;
    return {
      assetId: row.assetId,
      slackFileId: row.slackFileId,
      filename,
      contentType: row.contentType ?? inferMimetype(filename),
      status: row.status ?? "failed",
    };
  });
}

function mentionUserInfoMap(
  mentionDisplayNames: Readonly<Record<string, string>>,
): Map<string, SlackUserInfo> {
  return new Map(
    Object.entries(mentionDisplayNames).map(([id, name]) => {
      return [id, { id, name }] as const;
    }),
  );
}

export async function loadSlackQueuedLaunchMaterial(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<SlackQueuedLaunchMaterial | null> {
  const context = await loadSlackLaunchContext(db, args);
  if (!context) {
    return null;
  }
  const assets = await loadSlackPromptAssets(db, {
    userMessage: context.userMessage,
    userId: args.userId,
  });
  const messagePrompt = resolveUserMentions(
    context.messageText,
    mentionUserInfoMap(context.mentionDisplayNames),
  );
  return {
    prompt: canonicalSlackAgentPrompt(
      messagePrompt,
      context.messageFiles,
      assets,
    ),
    appendSystemPrompt: buildSlackSystemPrompt({
      botUserId: context.botUserId,
      channelId: context.channelId,
      channelType: context.channelType,
      threadTs: context.threadTs,
      executionContext: context.conversationContext,
    }),
    slackDelivery: {
      channelId: context.channelId,
      threadTs: context.threadTs,
      ...(context.routeThreadTs
        ? { routeThreadTs: context.routeThreadTs }
        : {}),
    },
    userInfoExtras:
      context.senderDisplayName || context.senderUserId
        ? {
            ...(context.senderDisplayName
              ? { slackDisplayName: context.senderDisplayName }
              : {}),
            ...(context.senderUserId
              ? { slackUserId: context.senderUserId }
              : {}),
          }
        : undefined,
  };
}
