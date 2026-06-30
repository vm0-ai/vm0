import chalk from "chalk";
import { Command } from "commander";

import { renameZeroChatThread } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface RenameOptions {
  readonly json?: boolean;
}

function getCurrentChatThreadId(): string | undefined {
  return process.env.ZERO_CHAT_THREAD_ID?.trim() || undefined;
}

function printUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

export const renameCommand = new Command()
  .name("rename")
  .description("Rename the current web chat thread")
  .argument("<title...>", "New chat title")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Rename this chat:  zero chat rename "Launch plan"

Notes:
  - Uses ZERO_CHAT_THREAD_ID from the current web chat thread
  - Authenticates via ZERO_TOKEN (requires chat-thread:write capability)`,
  )
  .action(
    withErrorHandler(async (titleParts: string[], options: RenameOptions) => {
      const title = titleParts.join(" ").trim();
      if (!title) {
        printUsageError(
          "Title is required",
          'Run: zero chat rename "New title"',
        );
      }

      const threadId = getCurrentChatThreadId();
      if (!threadId) {
        printUsageError(
          "ZERO_CHAT_THREAD_ID is not set",
          "Run this command from a Zero web chat thread.",
        );
      }

      const result = await renameZeroChatThread({ threadId, title });
      if (options.json) {
        console.log(JSON.stringify(result));
        return;
      }

      console.log(chalk.green("✓ Chat title updated"));
      console.log(chalk.dim(`  Thread: ${result.threadId}`));
      console.log(chalk.dim(`  Title:  ${result.title}`));
    }),
  );
