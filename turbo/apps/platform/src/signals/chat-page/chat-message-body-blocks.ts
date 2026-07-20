import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import { parseBodyBlocks, type ParsedBodyBlock } from "./parse-body-blocks.ts";
import { ATTACH_ONLY_PLACEHOLDER } from "./resolve-draft-attachments.ts";

function chatMessageBodyContent(message: PagedChatMessage): string {
  if (message.role === "assistant") {
    return message.content ?? "";
  }
  const content = (message.content ?? "").replace(
    /\[Attached file: ([^\]]+)\]\(([^)]+)\)(?:\nDownload with: curl [^\n]*)?\n?/g,
    "",
  );
  if (
    message.attachFiles &&
    message.attachFiles.length > 0 &&
    content.trim() === ATTACH_ONLY_PLACEHOLDER
  ) {
    return "";
  }
  return content.trim();
}

export function parseMessageBodyBlocks(
  message: PagedChatMessage,
): ParsedBodyBlock[] {
  const content = chatMessageBodyContent(message);
  return parseBodyBlocks(content, {
    previews: message.role === "assistant",
  }).blocks;
}
