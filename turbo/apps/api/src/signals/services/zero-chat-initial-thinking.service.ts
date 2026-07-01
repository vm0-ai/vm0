import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { generateText } from "../external/openrouter";
import { publishUserSignal } from "../external/realtime";
import { settle } from "../utils";
import { assistantMessageIdForRunEvent } from "./assistant-message-id";
import {
  runGroupIdForRun,
  visibleChatMessageCondition,
} from "./zero-chat-message-shared.service";

const log = logger("api:zero:chat-initial-thinking");

const FAST_CHAT_MODEL = "google/gemini-3.1-flash-lite-preview";
const INITIAL_THINKING_RUN_EVENT_ID = "thinking:initial";
const THINKING_CONTEXT_MESSAGE_CAP = 8;
const THINKING_CONTEXT_CHAR_CAP = 700;
const THINKING_MAX_TOKENS = 48;
const THINKING_TEXT_CHAR_CAP = 120;

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
    .replace(/\s+/g, " ")
    .replace(/^["'`]+/, "")
    .replace(/["'`.]+$/, "")
    .trim();
  if (!normalized) {
    return null;
  }
  return graphemes(normalized).slice(0, THINKING_TEXT_CHAR_CAP).join("");
}

async function loadThinkingContextMessages(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly runId: string;
}): Promise<ThinkingContextMessage[]> {
  const rows = await args.db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, args.threadId),
        isNotNull(chatMessages.content),
        inArray(chatMessages.role, ["user", "assistant"]),
        visibleChatMessageCondition(),
        isNull(chatMessages.runLifecycleEvent),
        isNull(chatMessages.recommendedFollowups),
        isNull(chatMessages.usagePayload),
        sql<boolean>`(${chatMessages.runId} IS NULL OR ${chatMessages.runId} != ${args.runId})`,
        sql<boolean>`(${chatMessages.runEventId} IS NULL OR ${chatMessages.runEventId} NOT IN ('queue:queued', 'queue:dequeued', ${INITIAL_THINKING_RUN_EVENT_ID}))`,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
    .limit(THINKING_CONTEXT_MESSAGE_CAP);

  return rows.reverse().flatMap((row) => {
    if (
      row.content === null ||
      (row.role !== "user" && row.role !== "assistant")
    ) {
      return [];
    }
    return [{ role: row.role, content: row.content }];
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
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, args.runId),
        eq(chatMessages.role, "assistant"),
        sql<boolean>`(${chatMessages.content} IS NOT NULL OR ${chatMessages.error} IS NOT NULL)`,
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
    FAST_CHAT_MODEL,
    [
      {
        role: "system",
        content: [
          "Write one short user-visible status line for a chat UI while the assistant starts responding.",
          "Use the current user message and recent history only to describe what is being prepared.",
          "Do not answer the user. Do not reveal hidden reasoning or chain-of-thought. Do not mention tools unless the user explicitly asked for a tool-like task.",
          "Match the user's language. Return plain text only, with no markdown, no quotes, and no trailing punctuation.",
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
  );

  return sanitizeThinkingText(text);
}

export async function generateAndPersistInitialThinkingMessage(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
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
  const generated = await settle(
    generateInitialThinkingText({
      currentPrompt: args.currentPrompt,
      history,
    }),
  );
  if (!generated.ok) {
    log.warn("Initial thinking generation failed", {
      threadId: args.threadId,
      runId: args.runId,
      err: generated.error,
    });
    return false;
  }

  const thinking = generated.value;
  if (thinking === null) {
    return false;
  }
  if (!(await runCanReceiveThinkingMessage(args))) {
    return false;
  }

  const [inserted] = await args.db
    .insert(chatMessages)
    .values({
      id: assistantMessageIdForRunEvent(
        args.runId,
        INITIAL_THINKING_RUN_EVENT_ID,
      ),
      chatThreadId: args.threadId,
      runId: args.runId,
      runGroupId: await runGroupIdForRun(args.db, args.runId),
      role: "assistant",
      content: null,
      thinking,
      runEventId: INITIAL_THINKING_RUN_EVENT_ID,
    })
    .onConflictDoNothing()
    .returning({ id: chatMessages.id });

  if (!inserted) {
    return false;
  }

  await publishUserSignal(
    [args.userId],
    `chatThreadMessageCreated:${args.threadId}`,
  );
  return true;
}
