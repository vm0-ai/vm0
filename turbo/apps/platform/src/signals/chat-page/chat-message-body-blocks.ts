import { chatEventCompatibilityRole } from "@vm0/api-contracts/contracts/chat-events";
import { messageDocumentToDisplayText } from "../zero-page/user-message-document-codec.ts";
import { parseBodyBlocks, type ParsedBodyBlock } from "./parse-body-blocks.ts";
import type { ChatMessage } from "./chat-message-types.ts";

function chatMessageBodyContent(message: ChatMessage): string {
  if (chatEventCompatibilityRole(message.eventType) === "assistant") {
    return message.content ?? "";
  }
  if (message.eventType === "input.automation") {
    return message.triggerBrief?.trim() ?? "";
  }
  if (
    message.eventType === "input.prompt" ||
    message.eventType === "input.rejected"
  ) {
    const content = messageDocumentToDisplayText(message.userMessage);
    if (content === null) {
      throw new Error(`${message.eventType} is missing a valid userMessage`);
    }
    return content.trim();
  }
  return message.content?.trim() ?? "";
}

export function parseMessageBodyBlocks(
  message: ChatMessage,
): ParsedBodyBlock[] {
  const content = chatMessageBodyContent(message);
  return parseBodyBlocks(content, {
    previews: chatEventCompatibilityRole(message.eventType) === "assistant",
  }).blocks;
}
