import { chatEventCompatibilityRole } from "@vm0/api-contracts/contracts/chat-events";
import { messageDocumentToDisplayText } from "../zero-page/user-message-document-codec.ts";
import { parseBodyBlocks, type ParsedBodyBlock } from "./parse-body-blocks.ts";
import type { ChatEvent } from "./chat-event-types.ts";

function chatEventBodyContent(event: ChatEvent): string {
  if (chatEventCompatibilityRole(event.eventType) === "assistant") {
    return event.content ?? "";
  }
  if (
    event.eventType === "input.prompt" ||
    event.eventType === "input.automation" ||
    event.eventType === "input.goal" ||
    event.eventType === "input.rejected"
  ) {
    if (event.eventType === "input.automation" && !event.userMessage) {
      return "";
    }
    const content = messageDocumentToDisplayText(event.userMessage);
    if (content === null) {
      throw new Error(`${event.eventType} is missing a valid userMessage`);
    }
    return content.trim();
  }
  return event.content?.trim() ?? "";
}

export function parseChatEventBodyBlocks(event: ChatEvent): ParsedBodyBlock[] {
  const content = chatEventBodyContent(event);
  return parseBodyBlocks(content, {
    previews: chatEventCompatibilityRole(event.eventType) === "assistant",
  }).blocks;
}
