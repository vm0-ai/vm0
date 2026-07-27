import { Command, Option } from "commander";

import { linkZeroMailDraft } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import {
  addRequestedCallbackSearchParams,
  connectorActionCallbackAvailable,
  printCallbackTurnInstruction,
} from "../connector/action-url";
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

function reviewUrlSearchParams(args: {
  readonly agentId: string;
  readonly callbackPrompt: string | undefined;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (args.callbackPrompt === undefined) {
    return params;
  }
  params.set("agentId", args.agentId);
  addRequestedCallbackSearchParams(params, args.callbackPrompt, args.agentId);
  return params;
}

function mailDraftReviewUrl(
  mailDraftUrl: string,
  params: URLSearchParams,
): string {
  const url = new URL(mailDraftUrl);
  for (const [name, value] of params) {
    url.searchParams.set(name, value);
  }
  return url.toString();
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
  ? '  zero mail link r-test-draft --callback-prompt "Confirm the email was sent, then offer reply tracking"\n'
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
  zero mail link r-test-draft
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
        const params = reviewUrlSearchParams({
          agentId,
          callbackPrompt: opts.callbackPrompt,
        });
        const result = await linkZeroMailDraft({
          threadId,
          agentId,
          gmailDraftId,
        });
        console.log(mailDraftReviewUrl(result.mailDraftUrl, params));
        if (opts.callbackPrompt !== undefined) {
          printCallbackTurnInstruction();
        }
      },
    ),
  );
