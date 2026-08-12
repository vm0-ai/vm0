import chalk from "chalk";

import { isUuid } from "../../../lib/utils/uuid";
import { getOkouChatThreadId } from "../../../lib/okou-env";

export function printChatUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

export function resolveChatThreadId(flagThreadId: string | undefined): string {
  const threadId = flagThreadId?.trim() || getOkouChatThreadId()?.trim();
  if (!threadId) {
    printChatUsageError(
      "ZERO_CHAT_THREAD_ID is not set",
      "Pass --thread-id <thread-id> or run inside a web chat thread.",
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
