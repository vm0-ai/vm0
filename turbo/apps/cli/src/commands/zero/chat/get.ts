import chalk from "chalk";
import { Command } from "commander";

import { getZeroChatThread } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface GetOptions {
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

export const getCommand = new Command()
  .name("get")
  .description("Show the current web chat thread")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Show this chat:    zero chat get
  Print JSON:        zero chat get --json

Notes:
  - Uses ZERO_CHAT_THREAD_ID from the current web chat thread
  - Authenticates via ZERO_TOKEN (requires chat-thread:read capability)`,
  )
  .action(
    withErrorHandler(async (options: GetOptions) => {
      const threadId = getCurrentChatThreadId();
      if (!threadId) {
        printUsageError(
          "ZERO_CHAT_THREAD_ID is not set",
          "Run this command from a Zero web chat thread.",
        );
      }

      const thread = await getZeroChatThread({ threadId });
      if (options.json) {
        console.log(JSON.stringify(thread));
        return;
      }

      console.log(chalk.green("✓ Chat thread loaded"));
      console.log(chalk.dim(`  Thread: ${thread.id}`));
      console.log(chalk.dim(`  Title:  ${thread.title ?? "(untitled)"}`));
    }),
  );
