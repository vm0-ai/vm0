import type { SlackFile } from "../../lib/slack-webhook-context";
import type { Db } from "../external/db";
import {
  memoryContentHash,
  recordMemorySource,
} from "./memory-substrate.service";
import { enqueueMemorySourceRelationshipExtractionJob } from "./relationship-memory-gmail-queue.service";
import { slackMemoryDocumentAdapter } from "./slack-memory-document-adapter.service";
import { recordConnectorMemoryDocument } from "./zero-memory-connector-adapter.service";

export type SlackMemoryChannelType =
  | "channel"
  | "group"
  | "mpim"
  | "im"
  | "unknown";

function dateFromSlackTs(value: string): Date | null {
  const [secondsText] = value.split(".");
  const seconds = Number(secondsText);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function slackMemoryExternalId(args: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
}): string {
  return [args.workspaceId, args.channelId, args.messageTs].join(":");
}

function slackMemorySourceTitle(channelType: SlackMemoryChannelType): string {
  switch (channelType) {
    case "im": {
      return "Slack direct message";
    }
    case "mpim": {
      return "Slack group direct message";
    }
    case "group": {
      return "Slack private channel message";
    }
    case "channel": {
      return "Slack channel message";
    }
    case "unknown": {
      return "Slack message";
    }
  }
}

export async function recordSlackMessageMemorySource(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: SlackMemoryChannelType;
  readonly slackUserId: string;
  readonly messageText: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly files?: readonly SlackFile[];
}): Promise<boolean> {
  const externalId = slackMemoryExternalId(args);
  const didRecordSource = await recordMemorySource(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "slack",
    sourceType: "slack_message",
    externalId,
    occurredAt: dateFromSlackTs(args.messageTs),
    title: slackMemorySourceTitle(args.channelType),
    contentHash: args.messageText ? memoryContentHash(args.messageText) : null,
    metadata: {
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      channelType: args.channelType,
      threadId: args.threadTs ?? null,
      messageTs: args.messageTs,
      senderId: args.slackUserId,
      participantIds: [args.slackUserId],
      fileIds: (args.files ?? []).flatMap((file) => {
        return file.id ? [file.id] : [];
      }),
    },
  });

  if (!didRecordSource) {
    return false;
  }

  await recordConnectorMemoryDocument({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    adapter: slackMemoryDocumentAdapter,
    input: {
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      channelType: args.channelType,
      senderId: args.slackUserId,
      messageText: args.messageText,
      messageTs: args.messageTs,
      threadTs: args.threadTs,
      files: args.files,
    },
  });

  await enqueueMemorySourceRelationshipExtractionJob(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "slack",
    sourceExternalId: externalId,
    priority: 20,
    replaceExisting: false,
    reason: "slack_source",
  });

  return true;
}
