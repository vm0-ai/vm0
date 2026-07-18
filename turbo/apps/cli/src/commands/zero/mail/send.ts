import chalk from "chalk";
import { Command } from "commander";

import { createZeroMailDraft } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { currentAgentId, parseMailProvider } from "./shared";

interface SendOptions {
  readonly provider?: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly gmailThreadId?: string;
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
  .description("Create a Gmail draft card for user approval")
  .requiredOption("--to <email...>", "Recipient email addresses")
  .option("--cc <email...>", "CC recipient email addresses")
  .option("--bcc <email...>", "BCC recipient email addresses")
  .requiredOption("--subject <text>", "Email subject")
  .requiredOption("--body <text>", "Plain-text email body")
  .option("--provider <provider>", "Mail provider (gmail only)")
  .option("--reply-to <value>", "Reply-To header")
  .option("--in-reply-to <message-id>", "In-Reply-To header")
  .option("--references <message-id...>", "References headers")
  .option("--gmail-thread-id <id>", "Gmail thread ID for a reply draft")
  .addHelpText(
    "after",
    `
Examples:
  Create draft:  zero mail send --to user@example.com --subject "Hello" --body "Hi there"
  Reply draft:   zero mail send --to user@example.com --subject "Re: Hello" --body "Reply" --in-reply-to "<message-id>" --references "<message-id>" --gmail-thread-id <thread-id>

Notes:
  - This creates a plain-text draft in Gmail; it does not send immediately
  - The user reviews and sends it from the card sidebar`,
  )
  .action(
    withErrorHandler(async (options: SendOptions) => {
      const provider = options.provider
        ? parseMailProvider(options.provider)
        : undefined;
      if (provider === "outlook") {
        throw new Error("Mail draft cards require Gmail", {
          cause: new Error("Use --provider gmail or omit --provider"),
        });
      }
      const result = await createZeroMailDraft({
        threadId: currentChatThreadId(),
        agentId: currentAgentId(),
        provider,
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        subject: options.subject,
        body: options.body,
        replyTo: options.replyTo,
        inReplyTo: options.inReplyTo,
        references: options.references,
        gmailThreadId: options.gmailThreadId,
      });
      console.log(chalk.green("✓ Gmail draft card created"));
      console.log(chalk.dim(`  Sender: ${result.mailDraft.from}`));
      console.log(chalk.dim(`  Draft: ${result.mailDraftId}`));
      console.log(chalk.dim(`  Card: ${result.mailDraftUrl}`));
      console.log(
        chalk.dim(
          "  The card is already visible in chat; do not repeat the draft in your response",
        ),
      );
    }),
  );
