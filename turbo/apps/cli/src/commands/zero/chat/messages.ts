import chalk from "chalk";
import { Command } from "commander";
import type {
  ChatEvent,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

import { listZeroChatEvents } from "../../../lib/api/domains/zero-chat";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { formatIsoTimestamp } from "../../../lib/utils/time-format";
import { parseBoundedLogCount } from "../../../lib/utils/log-pagination";
import { resolveChatThreadId } from "./shared";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PAGE_LIMIT = 50;

/** Per-thread chat event sequences start at 1, so this marks the oldest event. */
const FIRST_CHAT_EVENT_SEQ_ID = 1;

interface MessagesOptions {
  readonly threadId?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

interface ChatMessage {
  readonly eventId: string;
  readonly role: "user" | "assistant";
  readonly createdAt: string;
  readonly runId: string | null;
  readonly text: string;
}

function userMessageText(document: UserMessageDocument): string {
  return document.parts
    .map((part) => {
      return part.type === "text" ? part.text : "";
    })
    .join("")
    .trim();
}

function toChatMessage(event: ChatEvent): ChatMessage | null {
  if (event.eventType === "input.prompt") {
    return {
      eventId: event.id,
      role: "user",
      createdAt: event.createdAt,
      runId: event.runId ?? null,
      text: userMessageText(event.userMessage),
    };
  }
  if (event.eventType === "output.message") {
    return {
      eventId: event.id,
      role: "assistant",
      createdAt: event.createdAt,
      runId: event.runId ?? null,
      text: event.content.trim(),
    };
  }
  return null;
}

/**
 * A page holds every event type, so a page of 50 can carry a single message.
 * Walk backwards until the requested message count is filled or the thread's
 * first event is reached.
 */
async function loadRecentMessages(
  threadId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  let beforeSeqId: number | undefined;

  for (;;) {
    const events = await listZeroChatEvents({
      threadId,
      beforeSeqId,
      limit: PAGE_LIMIT,
    });
    const page = events.flatMap((event) => {
      const message = toChatMessage(event);
      return message ? [message] : [];
    });
    messages.unshift(...page);

    const oldestInPage = events[0];
    if (
      messages.length >= limit ||
      oldestInPage === undefined ||
      oldestInPage.seqId <= FIRST_CHAT_EVENT_SEQ_ID
    ) {
      return messages.slice(-limit);
    }
    beforeSeqId = oldestInPage.seqId;
  }
}

export const messagesCommand = new Command()
  .name("messages")
  .description("Read the messages in a web chat thread")
  .option(
    "--thread-id <id>",
    "Chat thread ID (defaults to ZERO_CHAT_THREAD_ID)",
  )
  .option(
    "--limit <n>",
    `Maximum number of messages to print (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Read this chat:     zero chat messages
  Read another chat:  zero chat messages --thread-id <thread-id>
  Read the last 5:    zero chat messages --limit 5
  Print JSON:         zero chat messages --thread-id <thread-id> --json

Notes:
  - Prints user and assistant messages oldest first, the order the chat UI shows
  - Reads a thread the current user owns, including one another agent run wrote into
  - Authenticates via ZERO_TOKEN (requires chat-event:read capability)`,
  )
  .action(
    withErrorHandler(async (options: MessagesOptions) => {
      const threadId = resolveChatThreadId(options.threadId);
      const limit =
        options.limit === undefined
          ? DEFAULT_LIMIT
          : parseBoundedLogCount(options.limit, "--limit", 1, MAX_LIMIT);
      const messages = await loadRecentMessages(threadId, limit);

      if (options.json) {
        console.log(
          JSON.stringify({ threadId, total: messages.length, messages }),
        );
        return;
      }

      if (messages.length === 0) {
        console.log(chalk.dim("No chat messages found"));
        console.log(
          chalk.dim(`  Send one: zero chat send --thread-id ${threadId}`),
        );
        return;
      }

      for (const message of messages) {
        console.log(
          `${chalk.dim(formatIsoTimestamp(message.createdAt))} ${chalk.bold(
            message.role === "user" ? "User" : "Assistant",
          )}`,
        );
        console.log(message.text || chalk.dim("(no message text)"));
        console.log();
      }
    }),
  );
