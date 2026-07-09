import type { SlackFile } from "../../lib/slack-webhook-context";
import type { SlackMemoryChannelType } from "./slack-memory-source.service";
import type { MemoryConnectorDocumentAdapter } from "./zero-memory-connector-adapter.service";

interface SlackMemoryDocumentInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: SlackMemoryChannelType;
  readonly senderId: string;
  readonly messageText: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly files?: readonly SlackFile[];
}

function slackConversationTitle(channelType: SlackMemoryChannelType): string {
  switch (channelType) {
    case "im": {
      return "Slack direct message";
    }
    case "mpim": {
      return "Slack group direct message";
    }
    case "group": {
      return "Slack private channel conversation";
    }
    case "channel": {
      return "Slack channel conversation";
    }
    case "unknown": {
      return "Slack conversation";
    }
  }
}

function slackDocumentContent(input: SlackMemoryDocumentInput): string {
  const files = (input.files ?? []).flatMap((file) => {
    return file.name ? [`File: ${file.name}`] : [];
  });
  return [
    `# ${slackConversationTitle(input.channelType)}`,
    "",
    `Sender: ${input.senderId}`,
    `Message timestamp: ${input.messageTs}`,
    "",
    input.messageText,
    ...files,
  ].join("\n");
}

function slackMessageDate(messageTs: string): Date | null {
  const seconds = Number(messageTs.split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

export function slackMemoryDocumentAdapter(
  input: SlackMemoryDocumentInput,
): ReturnType<MemoryConnectorDocumentAdapter<SlackMemoryDocumentInput>> {
  if (!input.messageText.trim() && (input.files ?? []).length === 0) {
    return null;
  }
  const conversationTs = input.threadTs ?? input.messageTs;
  const externalId = [input.workspaceId, input.channelId, input.messageTs].join(
    ":",
  );
  return {
    provider: "slack",
    sourceType: "slack_message",
    externalId,
    title: slackConversationTitle(input.channelType),
    content: slackDocumentContent(input),
    occurredAt: slackMessageDate(input.messageTs),
    contextSpace: {
      type: "project",
      key: `slack:${input.workspaceId}:${input.channelId}:${conversationTs}`,
      displayName: slackConversationTitle(input.channelType),
      metadata: {
        provider: "slack",
        externalId: `${input.channelId}:${conversationTs}`,
        displayName: slackConversationTitle(input.channelType),
        reason: "slack_message",
      },
    },
    metadata: {
      provider: "slack",
      sourceType: "slack_message",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      channelType: input.channelType,
      threadId: input.threadTs ?? null,
      messageId: input.messageTs,
      senderId: input.senderId,
      reason: "slack_message",
    },
    citation: {
      locator: `${input.channelId}:${input.messageTs}`,
    },
  };
}
