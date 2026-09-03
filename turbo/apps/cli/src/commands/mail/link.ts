import { Command, Option } from "commander";

import { linkMailDraft } from "../../lib/api/domains/mail";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getOkouChatThreadId } from "../../lib/okou-env";
import {
  connectorActionCallbackAvailable,
  finalizeActionUrl,
  printCallbackTurnInstruction,
} from "../connector/action-url";
import { currentAgentId } from "./shared";

function currentChatThreadId(): string {
  const threadId = getOkouChatThreadId()?.trim();
  if (!threadId) {
    throw new Error("OKOU_CHAT_THREAD_ID is not set", {
      cause: new Error("Run this command from a web chat thread"),
    });
  }
  return threadId;
}

function mailDraftReviewUrl(args: {
  readonly mailDraftUrl: string;
  readonly agentId: string;
  readonly callbackPrompt: string | undefined;
}): string {
  const actionUrl = new URL(args.mailDraftUrl);
  if (args.callbackPrompt !== undefined) {
    actionUrl.searchParams.set("agentId", args.agentId);
  }
  return finalizeActionUrl(actionUrl, args.callbackPrompt, args.agentId);
}

const callbackPromptOption = new Option(
  "--callback-prompt <prompt>",
  "Start the next web chat round with this prompt after the user sends the email",
);
const callbackPromptAvailable = connectorActionCallbackAvailable();
if (!callbackPromptAvailable) {
  callbackPromptOption.hideHelp();
}
const callbackPromptExample = callbackPromptAvailable
  ? '  okou mail link r-test-draft --callback-prompt "Confirm the email was sent, then offer reply tracking"\n'
  : "";
const callbackPromptNotes = callbackPromptAvailable
  ? "  - Use --callback-prompt only when this turn links exactly one draft and needs no other callback action\n  - Callback prompts are included in the URL; keep them concise and do not include secrets\n"
  : "";

export const linkCommand = new Command()
  .name("link")
  .description("Link an existing Gmail draft to the current web chat")
  .argument("<gmail-draft-id>", "Gmail draft ID")
  .addOption(callbackPromptOption)
  .addHelpText(
    "after",
    `
Examples:
  okou mail link r-test-draft
${callbackPromptExample}
Notes:
  - Outputs the review URL to return to the user
${callbackPromptNotes}  - The user reviews the draft and sends it from the linked email card`,
  )
  .action(
    withErrorHandler(
      async (gmailDraftId: string, opts: { callbackPrompt?: string }) => {
        const agentId = currentAgentId();
        const threadId = currentChatThreadId();
        const result = await linkMailDraft({
          threadId,
          agentId,
          gmailDraftId,
        });
        console.log(
          mailDraftReviewUrl({
            mailDraftUrl: result.mailDraftUrl,
            agentId,
            callbackPrompt: opts.callbackPrompt,
          }),
        );
        if (opts.callbackPrompt !== undefined) {
          printCallbackTurnInstruction();
        }
      },
    ),
  );
