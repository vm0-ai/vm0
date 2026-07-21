import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageRecommendedFollowups,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  type SQL,
} from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { publishThreadListChanged } from "../external/realtime";
import type { Db } from "../external/db";
import { nowDate } from "../external/time";
import { safeJsonParse, tapError } from "../utils";
import { visibleChatMessageCondition } from "./zero-chat-message-shared.service";
import {
  RECOMMENDED_FOLLOWUP_LIMIT,
  normalizeRecommendedFollowups,
} from "./zero-chat-recommended-followups.service";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";
import { queuedUserMessageExists } from "./zero-chat-queued-message.service";

const log = logger("api:zero:chat-title");
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const FAST_CHAT_MODEL = "google/gemini-3.1-flash-lite-preview";
const TITLE_CONTEXT_CHAR_CAP = 150;
const TITLE_PRIOR_MESSAGE_CAP = 10;
const FOLLOWUP_CONTEXT_CHAR_CAP = 700;
const FOLLOWUP_CONTEXT_MESSAGE_CAP = 8;
const BUILT_IN_GENERATION_FOLLOWUP_CONTEXT = [
  "Supported VM0 built-in generation tasks:",
  "- image: create or edit images and visual assets.",
  "- video: create short generated videos.",
  "- presentation: create slide decks or presentation documents.",
  "- website: create hosted websites or web pages.",
].join("\n");

export interface ChatCompletionContextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface ChatTitleInput {
  readonly currentUserMessage: string;
  readonly currentAssistantReply?: string;
  readonly priorRounds?: readonly ChatCompletionContextMessage[];
}

interface OpenRouterResponse {
  readonly choices: readonly {
    readonly message: {
      readonly content: string;
    };
  }[];
}

interface ChatMessageForGeneration {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

type SelectDb = Pick<Db, "select">;

export function isChatTitleGenerationConfigured(): boolean {
  return Boolean(optionalEnv("OPENROUTER_API_KEY"));
}

function completedConversationContextMessageCondition(db: SelectDb) {
  return and(
    not(queuedUserMessageExists(db)),
    not(
      and(
        isNotNull(chatMessages.runId),
        exists(
          db
            .select({ one: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, chatMessages.runId),
                inArray(agentRuns.status, ["queued", "pending", "running"]),
              ),
            ),
        ),
      ) as SQL,
    ),
  ) as SQL;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^["'](.+)["']$/, "$1")
    .trim();
}

async function generateText(
  messages: readonly ChatMessageForGeneration[],
  maxTokens = 30,
  options?: {
    readonly stripMarkdown?: boolean;
  },
): Promise<string | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    return null;
  }

  const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: FAST_CHAT_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = (await tapError(response.text())) ?? "unknown error";
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const rawContent = data.choices[0]?.message.content;
  if (rawContent === undefined) {
    throw new Error("OpenRouter returned empty content");
  }
  const content = rawContent.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }

  return options?.stripMarkdown === false ? content : stripMarkdown(content);
}

function generateChatTitle(input: ChatTitleInput): Promise<string | null> {
  const sections: string[] = [];

  if (input.priorRounds && input.priorRounds.length > 0) {
    const recent = input.priorRounds.slice(-TITLE_PRIOR_MESSAGE_CAP);
    const history = recent
      .map((message) => {
        return `${message.role}: ${message.content.slice(0, TITLE_CONTEXT_CHAR_CAP)}`;
      })
      .join("\n");
    sections.push(
      `Previous conversation (last ${recent.length} messages, for continuity):\n${history}`,
    );
  }

  sections.push(
    `Most recent user message:\n${input.currentUserMessage.slice(0, TITLE_CONTEXT_CHAR_CAP)}`,
  );
  if (input.currentAssistantReply) {
    sections.push(
      `Most recent assistant reply:\n${input.currentAssistantReply.slice(0, TITLE_CONTEXT_CHAR_CAP)}`,
    );
  }

  return generateText([
    {
      role: "system",
      content:
        "Generate a short, descriptive title (max 60 chars) for a chat conversation. Weight the most recent exchange highest, but use the earlier rounds to keep the title consistent as the thread evolves. Return only the title as plain text. Do not use any markdown syntax such as #, *, **, _, ---, ``` or quotes. Just plain text.",
    },
    {
      role: "user",
      content: sections.join("\n\n"),
    },
  ]);
}

async function getLatestTitleContextMessages(
  db: Db,
  threadId: string,
  options?: { readonly excludeRunId?: string },
): Promise<ChatCompletionContextMessage[]> {
  const filters = [
    eq(chatMessages.chatThreadId, threadId),
    isNotNull(chatMessages.content),
    inArray(chatMessages.role, ["user", "assistant"]),
    visibleChatMessageCondition(),
    completedConversationContextMessageCondition(db),
  ];
  if (options?.excludeRunId !== undefined) {
    filters.push(
      // Keep prior context free of the current exchange. User rows have the run
      // id too, so this excludes both sides of the just-completed round.
      or(
        isNull(chatMessages.runId),
        ne(chatMessages.runId, options.excludeRunId),
      ) as SQL,
    );
  }

  const rows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
    })
    .from(chatMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(and(...filters))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
    .limit(TITLE_PRIOR_MESSAGE_CAP);

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

async function updateChatThreadTitle(
  db: Db,
  threadId: string,
  userId: string,
  orgId: string | null,
  title: string,
): Promise<void> {
  const updated = await db.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ title, updatedAt: nowDate() })
      .where(
        and(
          eq(chatThreads.id, threadId),
          isNull(chatThreads.title),
          isNull(chatThreads.renamedAt),
        ),
      )
      .returning({
        id: chatThreads.id,
        agentComposeId: chatThreads.agentComposeId,
      });
    if (!thread) {
      return false;
    }
    await appendChatThreadEvent(tx, {
      kind: "renamed",
      userId,
      orgId,
      chatThreadId: thread.id,
      agentComposeId: thread.agentComposeId,
      title,
    });
    return true;
  });

  if (!updated) {
    return;
  }

  await publishThreadListChanged(userId);
}

async function shouldGenerateChatThreadTitle(
  db: SelectDb,
  threadId: string,
): Promise<boolean> {
  const [thread] = await db
    .select({ title: chatThreads.title, renamedAt: chatThreads.renamedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  return Boolean(thread && thread.title === null && thread.renamedAt === null);
}

export async function generateAndPersistChatThreadTitle(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string | null;
  readonly prompt: string;
  readonly includePriorRounds: boolean;
}): Promise<void> {
  await tapError(
    (async () => {
      if (!(await shouldGenerateChatThreadTitle(args.db, args.threadId))) {
        return;
      }

      const priorRounds = args.includePriorRounds
        ? await getLatestTitleContextMessages(args.db, args.threadId)
        : [];
      const title = await generateChatTitle({
        currentUserMessage: args.prompt,
        priorRounds: priorRounds.length > 0 ? priorRounds : undefined,
      });
      if (title) {
        await updateChatThreadTitle(
          args.db,
          args.threadId,
          args.userId,
          args.orgId,
          title,
        );
      }
    })(),
    (err) => {
      log.warn("Chat title generation failed", {
        threadId: args.threadId,
        err,
      });
    },
  );
}

export async function generateAndPersistChatThreadTitleFromCallback(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string | null;
  readonly runId: string;
  readonly prompt: string;
  readonly currentAssistantReply: string | undefined;
}): Promise<void> {
  await tapError(
    (async () => {
      if (!(await shouldGenerateChatThreadTitle(args.db, args.threadId))) {
        return;
      }

      const priorRounds = await getLatestTitleContextMessages(
        args.db,
        args.threadId,
        { excludeRunId: args.runId },
      );
      const title = await generateChatTitle({
        currentUserMessage: args.prompt,
        currentAssistantReply: args.currentAssistantReply,
        priorRounds: priorRounds.length > 0 ? priorRounds : undefined,
      });
      if (title) {
        await updateChatThreadTitle(
          args.db,
          args.threadId,
          args.userId,
          args.orgId,
          title,
        );
      }
    })(),
    (err) => {
      log.warn("Chat title generation failed", {
        threadId: args.threadId,
        err,
      });
    },
  );
}

export function generateChatNotificationSummary(
  prompt: string,
  resultText: string,
): Promise<string | null> {
  return generateText(
    [
      {
        role: "system",
        content:
          "Summarize this completed task in one short notification sentence, max 90 chars. Plain text only.",
      },
      {
        role: "user",
        content: `User request:\n${prompt.slice(0, TITLE_CONTEXT_CHAR_CAP)}\n\nAssistant reply:\n${resultText.slice(0, TITLE_CONTEXT_CHAR_CAP)}`,
      },
    ],
    35,
  );
}

function parseRecommendedFollowups(
  text: string,
): ChatMessageRecommendedFollowups {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return normalizeRecommendedFollowups(safeJsonParse(unfenced));
}

async function getLatestFollowupContextMessages(
  db: SelectDb,
  threadId: string,
): Promise<ChatCompletionContextMessage[]> {
  const rows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        isNotNull(chatMessages.content),
        inArray(chatMessages.role, ["user", "assistant"]),
        visibleChatMessageCondition(),
        completedConversationContextMessageCondition(db),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
    .limit(FOLLOWUP_CONTEXT_MESSAGE_CAP);

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

async function generateRecommendedFollowups(
  messages: readonly ChatCompletionContextMessage[],
): Promise<ChatMessageRecommendedFollowups> {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || last.content.trim().length === 0) {
    return [];
  }

  const context = messages
    .map((message) => {
      return `${message.role}: ${message.content.slice(0, FOLLOWUP_CONTEXT_CHAR_CAP)}`;
    })
    .join("\n\n");

  const text = await generateText(
    [
      {
        role: "system",
        content: [
          `Generate up to ${RECOMMENDED_FOLLOWUP_LIMIT.toString()} concise follow-up prompts the user may ask next in this chat.`,
          "Make each prompt specific to the latest assistant reply, actionable, and useful. Match the user's language.",
          'The "prompt" values are shown as plain text, not rendered as Markdown, so formatting characters will appear literally. Do not use Markdown or presentation-only syntax inside prompt values, including backticks around technical names, bold or italic markers, links, or bullet markers.',
          'Classify each item as kind "talk" for normal discussion, planning, analysis, or refinement, or kind "generate" when the prompt asks VM0 to create one of the supported built-in generation outputs.',
          BUILT_IN_GENERATION_FOLLOWUP_CONTEXT,
          "For generate items, include generationType as one of: image, video, presentation, website.",
          'Return only a JSON array of objects like {"prompt":"...","kind":"talk"} or {"prompt":"...","kind":"generate","generationType":"website"}. No markdown or extra text.',
        ].join("\n"),
      },
      {
        role: "user",
        content: `Recent conversation:\n${context}`,
      },
    ],
    260,
    { stripMarkdown: false },
  );

  return text === null ? [] : parseRecommendedFollowups(text);
}

export async function loadChatThreadRecommendedFollowupContext(args: {
  readonly db: SelectDb;
  readonly threadId: string;
}): Promise<ChatCompletionContextMessage[]> {
  return await getLatestFollowupContextMessages(args.db, args.threadId);
}

export async function generateChatThreadRecommendedFollowupsFromContext(args: {
  readonly messages: readonly ChatCompletionContextMessage[];
  readonly threadId?: string;
}): Promise<ChatMessageRecommendedFollowups> {
  return (
    (await tapError(generateRecommendedFollowups(args.messages), (err) => {
      log.warn("Recommended follow-up generation failed", {
        ...(args.threadId ? { threadId: args.threadId } : {}),
        err,
      });
    })) ?? []
  );
}
