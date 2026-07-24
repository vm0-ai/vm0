import chalk from "chalk";
import { Command } from "commander";

import { renameZeroChatThread } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { isUuid } from "../../../lib/utils/uuid";

interface RenameOptions {
  readonly json?: boolean;
  readonly thread?: string;
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
  .description("Rename a web chat thread")
  .argument("<title...>", "New chat title")
  .option("--thread <id>", "Chat thread ID (defaults to ZERO_CHAT_THREAD_ID)")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Rename this chat:  zero chat rename "Launch plan"
  Rename another:    zero chat rename --thread <thread-id> "Launch plan"

Notes:
  - Defaults --thread to ZERO_CHAT_THREAD_ID
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

      const threadId = options.thread?.trim() || getCurrentChatThreadId();
      if (!threadId) {
        printUsageError(
          "ZERO_CHAT_THREAD_ID is not set",
          "Pass --thread <thread-id> or run inside a Zero web chat thread.",
        );
      }
      if (!isUuid(threadId)) {
        printUsageError(
          `Invalid thread ID "${threadId}" — expected a UUID`,
          "Pass a valid UUID with --thread <thread-id>.",
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
