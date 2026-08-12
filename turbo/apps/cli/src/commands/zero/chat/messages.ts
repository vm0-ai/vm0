import chalk from "chalk";
import { Command } from "commander";
import { revokedChatEventIds } from "@vm0/api-contracts/contracts/chat-events";
import type {
  ChatEvent,
  UserMessageDocument,
  UserMessagePart,
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

type FeedbackNotePart = Extract<
  UserMessagePart,
  { readonly type: "feedback" }
>["note"][number];

/**
 * Parts that read as one sentence with their neighbours, so they concatenate
 * without a separator the way the chat UI renders them inline.
 */
function inlinePartText(part: UserMessagePart): string | null {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "chat_thread") {
    return `[Chat thread: ${part.titleSnapshot}]`;
  }
  if (part.type === "agent") {
    return `[Agent: ${part.nameSnapshot}]`;
  }
  return null;
}

function feedbackNotePartText(part: FeedbackNotePart): string {
  switch (part.type) {
    case "text": {
      return part.text;
    }
    case "chat_thread": {
      return `[Chat thread: ${part.titleSnapshot}]`;
    }
    case "agent": {
      return `[Agent: ${part.nameSnapshot}]`;
    }
    case "template": {
      return `[Template: ${part.titleSnapshot}]`;
    }
  }
}

/**
 * Parts that stand on their own line. `source` and `model` are provenance and
 * routing metadata rather than message content, so they render as nothing.
 */
function blockPartText(part: UserMessagePart): string | null {
  if (part.type === "file") {
    return `[File: ${part.filenameSnapshot}]`;
  }
  if (part.type === "template") {
    return `[Template: ${part.titleSnapshot}]`;
  }
  if (part.type === "automation") {
    return `[Automation: ${part.automationBrief ?? part.workflowName}]`;
  }
  if (part.type === "goal") {
    return `[Goal: ${part.goalBrief}]`;
  }
  if (part.type === "morning_brief") {
    return `[Morning brief: ${part.briefDate}]`;
  }
  if (part.type === "feedback") {
    const note = part.note.map(feedbackNotePartText).join("").trim();
    return `[Feedback on "${part.quote}"] ${note}`.trim();
  }
  return null;
}

/**
 * A message carries more than text: attachments, templates, automation and goal
 * triggers, and quoted feedback all appear in the chat UI. Rendering only text
 * parts would report a non-empty message as empty.
 */
function userMessageText(document: UserMessageDocument): string {
  const blocks: string[] = [];
  let inline = "";
  const flushInline = () => {
    if (inline.length > 0) {
      blocks.push(inline);
      inline = "";
    }
  };
  for (const part of document.parts) {
    const inlineText = inlinePartText(part);
    if (inlineText !== null) {
      inline += inlineText;
      continue;
    }
    const blockText = blockPartText(part);
    if (blockText !== null) {
      flushInline();
      blocks.push(blockText);
    }
  }
  flushInline();
  return blocks.join("\n").trim();
}

/**
 * Every user-role and assistant-role event that carries message text, matching
 * what the chat UI renders. Thinking, followups, control, browser, and usage
 * events are not messages, and neither are run lifecycle events except the
 * terminal ones, which carry the failure text the user reads.
 */
function toChatMessage(event: ChatEvent): ChatMessage | null {
  if (
    event.eventType === "input.prompt" ||
    event.eventType === "input.budget" ||
    event.eventType === "input.rejected" ||
    event.eventType === "input.goal"
  ) {
    return {
      eventId: event.id,
      role: "user",
      createdAt: event.createdAt,
      runId: event.runId ?? null,
      text: userMessageText(event.userMessage),
    };
  }
  if (event.eventType === "input.automation") {
    return {
      eventId: event.id,
      role: "user",
      createdAt: event.createdAt,
      runId: event.runId ?? null,
      text: event.userMessage ? userMessageText(event.userMessage) : "",
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
  if (event.eventType === "output.error") {
    return {
      eventId: event.id,
      role: "assistant",
      createdAt: event.createdAt,
      runId: event.runId ?? null,
      text: event.error.trim(),
    };
  }
  // A terminal run event carries the failure the user sees only when it has an
  // error. Without one it is a lifecycle marker, like queued and dequeued.
  if (event.eventType === "run.failed" || event.eventType === "run.cancelled") {
    const error = event.error?.trim();
    return error
      ? {
          eventId: event.id,
          role: "assistant",
          createdAt: event.createdAt,
          runId: event.runId,
          text: error,
        }
      : null;
  }
  return null;
}

/**
 * The thread event stream keeps a revoked event alongside the event that
 * replaced it, so claiming a queued message leaves two rows carrying the same
 * text. Reading the stream without folding revocations reports a conversation
 * that never happened.
 */
function foldMessages(events: readonly ChatEvent[]): ChatMessage[] {
  const revoked = revokedChatEventIds(events);
  return events.flatMap((event) => {
    if (revoked.has(event.id)) {
      return [];
    }
    const message = toChatMessage(event);
    return message ? [message] : [];
  });
}

/**
 * A page holds every event type, so a page of 50 can carry a single message.
 * Walk backwards until the requested message count is filled or the thread's
 * first event is reached. A revoking event is always newer than its target, so
 * paging from the newest end always holds the revoker once it holds the target.
 */
async function loadRecentMessages(
  threadId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const events: ChatEvent[] = [];
  let beforeSeqId: number | undefined;

  for (;;) {
    const page = await listZeroChatEvents({
      threadId,
      beforeSeqId,
      limit: PAGE_LIMIT,
    });
    events.unshift(...page);
    const messages = foldMessages(events);

    const oldestInPage = page[0];
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
  Read this chat:     okou chat messages
  Read another chat:  okou chat messages --thread-id <thread-id>
  Read the last 5:    okou chat messages --limit 5
  Print JSON:         okou chat messages --thread-id <thread-id> --json

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
          chalk.dim(`  Send one: okou chat send --thread-id ${threadId}`),
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
