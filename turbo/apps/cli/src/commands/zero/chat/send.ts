import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import chalk from "chalk";
import { Command } from "commander";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";

import { getZeroChatThreadAgentId, sendZeroChatEvent } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printChatUsageError, resolveChatThreadId } from "./shared";

interface SendOptions {
  readonly json?: boolean;
  readonly text?: string;
  readonly threadId?: string;
}

function readMessageText(optionText: string | undefined): string {
  let text = optionText;
  if (text === undefined && !process.stdin.isTTY) {
    try {
      text = readFileSync("/dev/stdin", "utf8");
    } catch {
      // stdin is not readable (for example in a test runner); the validation
      // below prints the same usage error as an interactive invocation.
    }
  }

  const trimmed = text?.trim();
  if (!trimmed) {
    printChatUsageError(
      "Chat message text is required",
      'Pass --text "message" or pipe the message on stdin.',
    );
  }
  return trimmed;
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a web chat thread")
  .option(
    "--thread-id <id>",
    "Chat thread ID (defaults to ZERO_CHAT_THREAD_ID)",
  )
  .option("-t, --text <message>", "Message text (or read it from stdin)")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Send to this chat:  zero chat send --text "Continue the analysis"
  Send to a thread:   zero chat send --thread-id <thread-id> --text "Continue"
  Pipe a message:     printf "Continue" | zero chat send --thread-id <thread-id>
  Print JSON:         zero chat send --text "Continue" --json

Notes:
  - Constructs a version 1 UserMessageDocument with one text part
  - Every normal message enters the thread queue first; an idle queue may dispatch it immediately
  - Authenticates via ZERO_TOKEN (requires chat-thread:read and chat-message:write capabilities)`,
  )
  .action(
    withErrorHandler(async (options: SendOptions) => {
      const threadId = resolveChatThreadId(options.threadId);
      const text = readMessageText(options.text);
      const agentId = await getZeroChatThreadAgentId({ threadId });
      const eventId = randomUUID();
      const userMessage = {
        version: 1,
        parts: [{ type: "text", text }],
      } satisfies UserMessageDocument;

      const result = await sendZeroChatEvent({
        agentId,
        threadId,
        prompt: text,
        hasTextContent: true,
        clientEventId: eventId,
        chatThreadSortEventId: randomUUID(),
        userMessage,
      });
      const queued = result.runId === null;

      if (options.json) {
        console.log(
          JSON.stringify({
            threadId: result.threadId,
            eventId,
            runId: result.runId,
            status: result.status ?? null,
            createdAt: result.createdAt ?? null,
            messageQueued: queued,
          }),
        );
        return;
      }

      console.log(
        chalk.green(
          queued ? "✓ Chat message queued" : "✓ Chat message dispatched",
        ),
      );
      console.log(chalk.dim(`  Thread: ${result.threadId}`));
      console.log(chalk.dim(`  Event:  ${eventId}`));
      if (result.runId) {
        console.log(chalk.dim(`  Run:    ${result.runId}`));
      }
      if (result.status) {
        console.log(chalk.dim(`  Status: ${result.status}`));
      }
    }),
  );
