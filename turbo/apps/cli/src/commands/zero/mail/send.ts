import chalk from "chalk";
import { Command } from "commander";

import { createZeroMailDraft } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { currentAgentId, parseMailProvider } from "./shared";

interface SendOptions {
  readonly provider?: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

function currentChatThreadId(): string {
  const threadId = process.env.ZERO_CHAT_THREAD_ID?.trim();
  if (!threadId) {
    throw new Error("ZERO_CHAT_THREAD_ID is not set", {
      cause: new Error("Run this command from a Zero web chat thread"),
    });
  }
  return threadId;
}

export const sendCommand = new Command()
  .name("send")
  .description("Create a persistent, editable mail card for user approval")
  .requiredOption("--to <email...>", "Recipient email addresses")
  .requiredOption("--subject <text>", "Email subject")
  .requiredOption("--body <text>", "Plain-text email body")
  .option("--provider <provider>", "Mail provider: gmail or outlook")
  .addHelpText(
    "after",
    `
Examples:
  Auto-select provider:  zero mail send --to user@example.com --subject "Hello" --body "Hi there"
  Select Gmail:          zero mail send --provider gmail --to user@example.com --subject "Hello" --body "Hi there"

Notes:
  - This creates an editable card in the current web chat; it does not send immediately
  - The user reviews the fixed sender, recipients, subject, and body before sending
  - When both providers are ready, --provider is required`,
  )
  .action(
    withErrorHandler(async (options: SendOptions) => {
      const provider = options.provider
        ? parseMailProvider(options.provider)
        : undefined;
      const result = await createZeroMailDraft({
        threadId: currentChatThreadId(),
        agentId: currentAgentId(),
        provider,
        to: options.to,
        subject: options.subject,
        body: options.body,
      });
      console.log(chalk.green("✓ Mail draft card created"));
      console.log(chalk.dim(`  Sender: ${result.mailDraft.from}`));
      console.log(chalk.dim(`  Message: ${result.messageId}`));
      console.log(
        chalk.dim(
          "  The card is already visible in chat; do not repeat the draft in your response",
        ),
      );
    }),
  );
