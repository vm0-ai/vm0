import chalk from "chalk";

import { isUuid } from "../../../lib/utils/uuid";

export function printChatUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

export function resolveChatThreadId(flagThreadId: string | undefined): string {
  const threadId =
    flagThreadId?.trim() || process.env.ZERO_CHAT_THREAD_ID?.trim();
  if (!threadId) {
    printChatUsageError(
      "ZERO_CHAT_THREAD_ID is not set",
      "Pass --thread-id <thread-id> or run inside a Zero web chat thread.",
    );
  }
  if (!isUuid(threadId)) {
    printChatUsageError(
      `Invalid thread ID "${threadId}" — expected a UUID`,
      "Pass a valid UUID with --thread-id <thread-id>.",
    );
  }
  return threadId;
}
