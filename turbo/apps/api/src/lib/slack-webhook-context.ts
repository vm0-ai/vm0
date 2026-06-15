import type { WebClient } from "@slack/web-api";

import {
  fetchSlackUserInfoMap,
  formatSenderBlock,
  type SlackUserInfo,
} from "../signals/external/slack-message-client";

export interface SlackFile {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly filetype?: string;
  readonly pretty_type?: string;
  readonly size?: number;
  readonly original_w?: string;
  readonly original_h?: string;
  readonly thumb_360?: string;
  readonly thumb_480?: string;
  readonly permalink?: string;
  readonly permalink_public?: string;
  readonly url_private_download?: string;
}

interface SlackAttachment {
  readonly image_url?: string;
  readonly image_width?: number;
  readonly image_height?: number;
  readonly thumb_url?: string;
  readonly title?: string;
  readonly fallback?: string;
}

interface RichTextStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
}

interface RichTextElement {
  readonly type: string;
  readonly text?: string;
  readonly url?: string;
  readonly name?: string;
  readonly unicode?: string;
  readonly user_id?: string;
  readonly usergroup_id?: string;
  readonly channel_id?: string;
  readonly range?: string;
  readonly style?: RichTextStyle | string;
  readonly indent?: number;
  readonly offset?: number;
  readonly language?: string;
  readonly elements?: readonly RichTextElement[];
}

interface SlackBlock {
  readonly type: string;
  readonly elements?: readonly RichTextElement[];
}

interface SlackMessage {
  readonly user?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly bot_id?: string;
  readonly files?: readonly SlackFile[];
  readonly attachments?: readonly SlackAttachment[];
  readonly blocks?: readonly SlackBlock[];
}

async function fetchThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
  limit = 100,
): Promise<readonly SlackMessage[]> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit,
  });
  return (result.messages ?? []) as SlackMessage[];
}

async function fetchChannelContext(
  client: WebClient,
  channel: string,
  limit = 10,
  latest?: string,
): Promise<readonly SlackMessage[]> {
  const result = await client.conversations.history({
    channel,
    limit,
    ...(latest && { latest }),
  });
  return [...((result.messages ?? []) as SlackMessage[])].reverse();
}

function applyTextStyle(
  text: string,
  style: RichTextStyle | string | undefined,
): string {
  if (typeof style === "string" || !style) {
    return text;
  }
  if (style.code) {
    return `\`${text}\``;
  }
  let result = text;
  if (style.bold) {
    result = `**${result}**`;
  }
  if (style.italic) {
    result = `_${result}_`;
  }
  if (style.strike) {
    result = `~${result}~`;
  }
  return result;
}

function formatInlineElement(element: RichTextElement): string {
  switch (element.type) {
    case "text": {
      return applyTextStyle(element.text ?? "", element.style);
    }
    case "link": {
      return element.url
        ? `[${element.text ?? element.url}](${element.url})`
        : (element.text ?? "");
    }
    case "emoji": {
      return element.unicode
        ? String.fromCodePoint(
            ...element.unicode.split("-").map((hex) => {
              return Number.parseInt(hex, 16);
            }),
          )
        : `:${element.name ?? "emoji"}:`;
    }
    case "user": {
      return `<@${element.user_id ?? "unknown"}>`;
    }
    case "usergroup": {
      return `<!subteam^${element.usergroup_id ?? "unknown"}>`;
    }
    case "channel": {
      return `<#${element.channel_id ?? "unknown"}>`;
    }
    case "broadcast": {
      return `@${element.range ?? "here"}`;
    }
    default: {
      return element.text ?? "";
    }
  }
}

function inlineElementsToText(elements: readonly RichTextElement[]): string {
  return elements.map(formatInlineElement).join("");
}

function formatRichTextList(section: RichTextElement): string[] {
  const indent = "  ".repeat(section.indent ?? 0);
  const listStyle =
    typeof section.style === "string" ? section.style : undefined;
  const parts: string[] = [];
  const elements = section.elements ?? [];
  for (const [index, item] of elements.entries()) {
    const bullet =
      listStyle === "ordered" ? `${(section.offset ?? 0) + index + 1}.` : "-";
    parts.push(
      `${indent}${bullet} ${inlineElementsToText(item.elements ?? [])}`,
    );
  }
  return parts;
}

function formatRichTextSection(section: RichTextElement): string[] {
  switch (section.type) {
    case "rich_text_section": {
      return [inlineElementsToText(section.elements ?? [])];
    }
    case "rich_text_list": {
      return formatRichTextList(section);
    }
    case "rich_text_preformatted": {
      const code = inlineElementsToText(section.elements ?? []);
      const language = section.language ?? "";
      return [`\`\`\`${language}\n${code}\n\`\`\``];
    }
    case "rich_text_quote": {
      return [
        inlineElementsToText(section.elements ?? [])
          .split("\n")
          .map((line) => {
            return `> ${line}`;
          })
          .join("\n"),
      ];
    }
    default: {
      return [];
    }
  }
}

function extractTextFromBlocks(
  blocks: readonly SlackBlock[] | undefined,
): string | undefined {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "rich_text") {
      continue;
    }
    for (const section of block.elements ?? []) {
      parts.push(...formatRichTextSection(section));
    }
  }

  const result = parts.join("\n");
  return result.length > 0 ? result : undefined;
}

function formatFileInfo(file: SlackFile): string {
  const parts: string[] = [];
  const name = file.name || file.title || "Untitled";
  const type = file.pretty_type || file.mimetype || "file";
  parts.push(`[Slack file] ${name} (${type})`);

  if (file.original_w && file.original_h) {
    parts.push(`   [Dimensions] ${file.original_w}x${file.original_h}`);
  }
  if (file.id) {
    parts.push(`   [ID] ${file.id}`);
  } else {
    const url =
      file.permalink_public ||
      file.thumb_480 ||
      file.thumb_360 ||
      file.permalink;
    if (url) {
      parts.push(`   [URL] ${url}`);
    }
  }

  return parts.join("\n");
}

function formatAttachmentImage(attachment: SlackAttachment): string | null {
  if (!attachment.image_url && !attachment.thumb_url) {
    return null;
  }
  const parts: string[] = [];
  const title = attachment.title || attachment.fallback || "Image";
  parts.push(`[image]: ${title}`);
  if (attachment.image_width && attachment.image_height) {
    parts.push(
      `   [Dimensions] ${attachment.image_width}x${attachment.image_height}`,
    );
  }
  const url = attachment.image_url || attachment.thumb_url;
  if (url) {
    parts.push(
      `   View: curl -sS -o /tmp/attachment_image.jpg "${url}" && read /tmp/attachment_image.jpg`,
    );
  }
  return parts.join("\n");
}

function resolveUserMentions(
  text: string,
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  if (!userInfoMap || userInfoMap.size === 0) {
    return text;
  }
  return text.replace(/<@(\w+)>/g, (_match, userId: string) => {
    const info = userInfoMap.get(userId);
    return info?.name ? `@${info.name} (${userId})` : `<@${userId}>`;
  });
}

function extractMentionedUserIds(messages: readonly SlackMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    addMentionedUserIdsFromBlocks(message.blocks, ids);
    if (message.text) {
      for (const match of message.text.matchAll(/<@(\w+)>/g)) {
        const userId = match[1];
        if (userId) {
          ids.add(userId);
        }
      }
    }
  }
  return [...ids];
}

function addMentionedUserIdsFromBlocks(
  blocks: readonly SlackBlock[] | undefined,
  ids: Set<string>,
): void {
  for (const block of blocks ?? []) {
    for (const section of block.elements ?? []) {
      addMentionedUserIdsFromElements(section.elements, ids);
    }
  }
}

function addMentionedUserIdsFromElements(
  elements: readonly RichTextElement[] | undefined,
  ids: Set<string>,
): void {
  for (const element of elements ?? []) {
    if (element.type === "user" && element.user_id) {
      ids.add(element.user_id);
    }
  }
}

function formatMessageWithMetadata(
  message: SlackMessage,
  relativeIndex: number,
  fileParts: readonly string[],
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  const senderId = message.bot_id ? "BOT" : (message.user ?? "unknown");
  const userInfo = userInfoMap?.get(senderId);
  const rawText = extractTextFromBlocks(message.blocks) ?? message.text ?? "";
  const text = resolveUserMentions(rawText, userInfoMap);

  const parts = [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    formatSenderBlock(userInfo ?? { id: senderId }),
    "",
    text,
  ];
  if (fileParts.length > 0) {
    parts.push(...fileParts);
  }
  return parts.join("\n");
}

const CONTEXT_PREAMBLE = [
  "The messages below are from a Slack conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent \u2014 prioritize them.",
  "- Match the tone of the conversation \u2014 casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
].join("\n");

function formatContextForAgent(
  messages: readonly SlackMessage[],
  contextType: "thread" | "channel" = "thread",
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;
  const formattedMessages = messages.map((message, index) => {
    const fileParts: string[] = [];
    for (const file of message.files ?? []) {
      fileParts.push(formatFileInfo(file));
    }
    for (const attachment of message.attachments ?? []) {
      const attachmentInfo = formatAttachmentImage(attachment);
      if (attachmentInfo) {
        fileParts.push(attachmentInfo);
      }
    }
    return formatMessageWithMetadata(
      message,
      index - totalMessages,
      fileParts,
      userInfoMap,
    );
  });

  const header =
    contextType === "thread"
      ? "# Slack Thread Context"
      : "# Recent Channel Messages";
  return `${header}\n\n${CONTEXT_PREAMBLE}\n\n${formattedMessages.join(
    "\n\n",
  )}\n\n---`;
}

function formatCurrentMessageFiles(files: readonly SlackFile[]): string {
  return files.map(formatFileInfo).join("\n");
}

export async function fetchConversationContexts(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  currentMessageTs?: string,
): Promise<{ readonly executionContext: string }> {
  const isDm = channelId.startsWith("D");
  const contextType = threadTs ? "thread" : "channel";
  const allMessages = threadTs
    ? await fetchThreadContext(client, channelId, threadTs)
    : isDm
      ? []
      : await fetchChannelContext(client, channelId, 10);
  const channelMessages =
    threadTs && !isDm
      ? await fetchChannelContext(client, channelId, 10, threadTs)
      : [];
  const contextMessages = currentMessageTs
    ? allMessages.filter((message) => {
        return message.ts !== currentMessageTs;
      })
    : allMessages;
  const allContextMessages = [...channelMessages, ...allMessages];
  const senderIds = allContextMessages.flatMap((message) => {
    return message.user && !message.bot_id ? [message.user] : [];
  });
  const mentionedIds = extractMentionedUserIds(allContextMessages);
  const userInfoMap = await fetchSlackUserInfoMap(client, [
    ...senderIds,
    ...mentionedIds,
  ]);
  const channelContextPrefix =
    channelMessages.length > 0
      ? formatContextForAgent(channelMessages, "channel", userInfoMap)
      : "";
  const threadExecContext =
    contextMessages.length > 0
      ? formatContextForAgent(contextMessages, contextType, userInfoMap)
      : "";
  return {
    executionContext: channelContextPrefix
      ? `${channelContextPrefix}\n\n${threadExecContext}`
      : threadExecContext,
  };
}

export async function enrichMessageContent(opts: {
  readonly messageContent: string;
  readonly files: readonly SlackFile[] | undefined;
  readonly client: WebClient;
  readonly userId: string;
}): Promise<{
  readonly prompt: string;
  readonly userInfoExtras: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
  };
}> {
  let prompt = opts.messageContent;
  if (opts.files && opts.files.length > 0) {
    prompt = `${prompt}\n\n${formatCurrentMessageFiles(opts.files)}`;
  }

  const mentionedIds = extractMentionedUserIds([{ text: opts.messageContent }]);
  const userInfoMap = await fetchSlackUserInfoMap(opts.client, [
    opts.userId,
    ...mentionedIds,
  ]);
  prompt = resolveUserMentions(prompt, userInfoMap);

  const currentUser = userInfoMap.get(opts.userId);
  return {
    prompt,
    userInfoExtras: currentUser
      ? {
          slackDisplayName: currentUser.name,
          slackUserId: currentUser.id,
        }
      : {},
  };
}
