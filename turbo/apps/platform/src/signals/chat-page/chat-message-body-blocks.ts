import { chatEventCompatibilityRole } from "@vm0/api-contracts/contracts/chat-events";
import { parseBodyBlocks, type ParsedBodyBlock } from "./parse-body-blocks.ts";
import { ATTACH_ONLY_PLACEHOLDER } from "./resolve-draft-attachments.ts";
import type { ChatMessage } from "./chat-message-types.ts";

function chatMessageBodyContent(message: ChatMessage): string {
  if (chatEventCompatibilityRole(message.eventType) === "assistant") {
    return message.content ?? "";
  }
  if (message.eventType === "input.automation") {
    return message.triggerBrief?.trim() ?? "";
  }
  const content = (message.content ?? "").replace(
    /\[Attached file: ([^\]]+)\]\(([^)]+)\)(?:\nDownload with: curl [^\n]*)?\n?/g,
    "",
  );
  const attachFiles =
    message.eventType === "input.prompt" ||
    message.eventType === "input.rejected"
      ? message.attachFiles
      : undefined;
  if (
    attachFiles &&
    attachFiles.length > 0 &&
    content.trim() === ATTACH_ONLY_PLACEHOLDER
  ) {
    return "";
  }
  return content.trim();
}

export function parseMessageBodyBlocks(
  message: ChatMessage,
): ParsedBodyBlock[] {
  const content = chatMessageBodyContent(message);
  return parseBodyBlocks(content, {
    previews: chatEventCompatibilityRole(message.eventType) === "assistant",
  }).blocks;
}
