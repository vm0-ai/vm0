import { Command } from "commander";

import { linkZeroMailDraft } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { currentAgentId } from "./shared";

function currentChatThreadId(): string {
  const threadId = process.env.ZERO_CHAT_THREAD_ID?.trim();
  if (!threadId) {
    throw new Error("ZERO_CHAT_THREAD_ID is not set", {
      cause: new Error("Run this command from a Zero web chat thread"),
    });
  }
  return threadId;
}

export const linkCommand = new Command()
  .name("link")
  .description("Link an existing Gmail draft to the current web chat")
  .argument("<gmail-draft-id>", "Gmail draft ID")
  .action(
    withErrorHandler(async (gmailDraftId: string) => {
      const result = await linkZeroMailDraft({
        threadId: currentChatThreadId(),
        agentId: currentAgentId(),
        gmailDraftId,
      });
      console.log(result.mailDraftUrl);
    }),
  );
