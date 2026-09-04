import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatEventCompatibilityRole } from "@okouai/api-contracts/contracts/chat-events";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  not,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { FAST_PATH_MODEL, generateText } from "../external/openrouter";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { tapError } from "../utils";
import { assistantEventIdForRunEvent } from "./assistant-event-id";
import {
  goalIdForRun,
  visibleChatEventCondition,
} from "./chat-event-shared.service";
import { insertChatEvent } from "./chat-event.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { queuedUserMessageExists } from "./chat-queued-event.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  canonicalChatEventContent,
  canonicalChatEventError,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";

const log = logger("api:chat-initial-thinking");

const INITIAL_THINKING_RUN_EVENT_ID = "thinking:initial";
const THINKING_CONTEXT_MESSAGE_CAP = 8;
const THINKING_CONTEXT_CHAR_CAP = 700;
const THINKING_MAX_TOKENS = 160;
const THINKING_TEXT_CHAR_CAP = 600;

interface ThinkingContextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

function graphemes(text: string): string[] {
  return Array.from(text);
}

function sanitizeThinkingText(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
  if (!normalized) {
    return null;
  }
  return graphemes(normalized)
    .slice(0, THINKING_TEXT_CHAR_CAP)
    .join("")
    .trimEnd();
}

async function loadThinkingContextMessages(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly runId: string;
}): Promise<ThinkingContextMessage[]> {
  const rows = await args.db
    .select({
      eventType: chatEvents.eventType,
      content: canonicalChatEventContent(),
      userMessage: canonicalChatEventUserMessage(),
      createdAt: chatEvents.createdAt,
      sequenceNumber: chatEvents.runEventSequenceNumber,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, args.threadId),
        chatEventTypeIn([
          "input.prompt",
          "input.rejected",
          "output.message",
          "output.error",
        ]),
        or(
          and(
            chatEventTypeIn(["input.prompt", "input.rejected"]),
            isNotNull(canonicalChatEventUserMessage()),
          ),
          and(
            not(chatEventTypeIn(["input.prompt", "input.rejected"])),
            isNotNull(canonicalChatEventContent()),
          ),
        ),
        visibleChatEventCondition(args.db),
        not(queuedUserMessageExists(args.db)),
        or(isNull(chatEvents.runId), ne(chatEvents.runId, args.runId)) as SQL,
        or(
          isNull(chatEvents.runEventId),
          notInArray(chatEvents.runEventId, [
            "queue:queued",
            "queue:dequeued",
            INITIAL_THINKING_RUN_EVENT_ID,
          ]),
        ) as SQL,
      ),
    )
    .orderBy(desc(chatEvents.seqId))
    .limit(THINKING_CONTEXT_MESSAGE_CAP);

  return rows.reverse().flatMap((row) => {
    const userMessage = requiredUserMessageForEvent(
      row.eventType,
      row.userMessage,
    );
    const content = userMessage
      ? projectUserMessage(userMessage).agentPrompt
      : row.content;
    if (content === null) {
      return [];
    }
    return [
      {
        role: chatEventCompatibilityRole(row.eventType),
        content,
      },
    ];
  });
}

async function runCanReceiveThinkingMessage(args: {
  readonly db: Db;
  readonly runId: string;
}): Promise<boolean> {
  const [run] = await args.db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  if (!run || run.status === "queued") {
    return false;
  }
  if (run.status !== "pending" && run.status !== "running") {
    return false;
  }

  const [assistantText] = await args.db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, args.runId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.queued",
          "run.failed",
          "run.cancelled",
        ]),
        or(
          isNotNull(canonicalChatEventContent()),
          isNotNull(canonicalChatEventError()),
        ) as SQL,
      ),
    )
    .limit(1);

  return assistantText === undefined;
}

async function generateInitialThinkingText(args: {
  readonly currentPrompt: string;
  readonly history: readonly ThinkingContextMessage[];
}): Promise<string | null> {
  const history = args.history
    .map((message) => {
      return `${message.role}: ${message.content.slice(0, THINKING_CONTEXT_CHAR_CAP)}`;
    })
    .join("\n\n");

  const text = await generateText(
    FAST_PATH_MODEL,
    [
      {
        role: "system",
        content: [
          "Write user-visible progress copy for a chat UI while the assistant is preparing its separate response.",
          "The UI shows one paragraph at a time, then replaces it with the next. On a typical mobile screen, a paragraph visibly holds about 30 characters, excluding punctuation; overflow is ellipsized and never shown later. A few distinct paragraphs give the animation enough material to rotate.",
          "Use the current user message and recent thread history as context for around four short paragraphs about what is being prepared. Keep each paragraph close to the visible mobile width, concrete, relevant, and specific rather than generic or repetitive.",
          "Do not answer the user. Do not reveal hidden reasoning, chain-of-thought, private analysis, or internal steps. Do not mention tools unless the user explicitly asked for a tool-like task.",
          "Match the current user's language.",
          "Return plain text only. Separate paragraphs with a single newline. Do not use markdown, headings, bullets, or quotes.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Current user message:\n${args.currentPrompt.slice(0, THINKING_CONTEXT_CHAR_CAP)}`,
          history ? `Recent thread history:\n${history}` : "",
        ]
          .filter((section) => {
            return section.length > 0;
          })
          .join("\n\n"),
      },
    ],
    THINKING_MAX_TOKENS,
    { reasoning: { effort: "none" } },
  );

  return sanitizeThinkingText(text);
}

export async function generateAndPersistInitialThinkingMessage(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly currentPrompt: string;
}): Promise<boolean> {
  if (args.currentPrompt.trim().length === 0) {
    return false;
  }
  if (!(await runCanReceiveThinkingMessage(args))) {
    return false;
  }

  const history = await loadThinkingContextMessages(args);
  const thinking = await tapError(
    generateInitialThinkingText({
      currentPrompt: args.currentPrompt,
      history,
    }),
    (err) => {
      log.warn("Initial thinking generation failed", {
        threadId: args.threadId,
        runId: args.runId,
        err,
      });
    },
  );
  if (thinking === undefined) {
    return false;
  }
  if (thinking === null) {
    return false;
  }
  if (!(await runCanReceiveThinkingMessage(args))) {
    return false;
  }

  const goalId = await goalIdForRun(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    return await insertChatEvent(
      tx,
      {
        id: assistantEventIdForRunEvent(
          args.runId,
          INITIAL_THINKING_RUN_EVENT_ID,
        ),
        chatThreadId: args.threadId,
        runId: args.runId,
        runGroupId: goalId,
        eventType: "output.thinking",
        content: null,
        thinking,
        runEventId: INITIAL_THINKING_RUN_EVENT_ID,
      },
      "any",
    );
  });

  if (!inserted) {
    return false;
  }

  await publishChatThreadMessageCreatedSafely(args);
  return true;
}
