import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageRecommendedFollowup,
  type ChatMessageRecommendedFollowupGenerationType,
  type ChatMessageRecommendedFollowups,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { publishThreadListChanged } from "../external/realtime";
import type { Db } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { visibleChatMessageCondition } from "./zero-chat-thread.service";

const log = logger("api:zero:chat-title");
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const FAST_CHAT_MODEL = "google/gemini-3.1-flash-lite-preview";
const TITLE_CONTEXT_CHAR_CAP = 150;
const TITLE_PRIOR_MESSAGE_CAP = 10;
const FOLLOWUP_CONTEXT_CHAR_CAP = 700;
const FOLLOWUP_CONTEXT_MESSAGE_CAP = 8;
const FOLLOWUP_LIMIT = 3;
const BUILT_IN_GENERATION_FOLLOWUP_CONTEXT = [
  "Supported VM0 built-in generation tasks:",
  "- image: create or edit images and visual assets.",
  "- video: create short generated videos.",
  "- presentation: create slide decks or presentation documents.",
  "- website: create hosted websites or web pages.",
].join("\n");

interface TitleContextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface ChatTitleInput {
  readonly currentUserMessage: string;
  readonly currentAssistantReply?: string;
  readonly priorRounds?: readonly TitleContextMessage[];
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
  options?: { readonly stripMarkdown?: boolean },
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
    const settled = await settle(response.text());
    const text = settled.ok ? settled.value : "unknown error";
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content.trim();
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
): Promise<TitleContextMessage[]> {
  const filters = [
    eq(chatMessages.chatThreadId, threadId),
    isNotNull(chatMessages.content),
    inArray(chatMessages.role, ["user", "assistant"]),
    visibleChatMessageCondition(),
  ];
  if (options?.excludeRunId !== undefined) {
    filters.push(
      // Keep prior context free of the current exchange. User rows have the run
      // id too, so this excludes both sides of the just-completed round.
      sql`(${chatMessages.runId} IS NULL OR ${chatMessages.runId} != ${options.excludeRunId})`,
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
  title: string,
): Promise<void> {
  const [thread] = await db
    .select({ renamedAt: chatThreads.renamedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  if (thread?.renamedAt) {
    return;
  }

  await db
    .update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId));
  await publishThreadListChanged(userId);
}

export async function generateAndPersistChatThreadTitle(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly includePriorRounds: boolean;
}): Promise<void> {
  const result = await settle(
    (async () => {
      const priorRounds = args.includePriorRounds
        ? await getLatestTitleContextMessages(args.db, args.threadId)
        : [];
      const title = await generateChatTitle({
        currentUserMessage: args.prompt,
        priorRounds: priorRounds.length > 0 ? priorRounds : undefined,
      });
      if (title) {
        await updateChatThreadTitle(args.db, args.threadId, args.userId, title);
      }
    })(),
  );
  if (!result.ok) {
    log.warn("Chat title generation failed", {
      threadId: args.threadId,
      err: result.error,
    });
  }
}

export async function generateAndPersistChatThreadTitleFromCallback(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly currentAssistantReply: string | undefined;
}): Promise<void> {
  const result = await settle(
    (async () => {
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
        await updateChatThreadTitle(args.db, args.threadId, args.userId, title);
      }
    })(),
  );
  if (!result.ok) {
    log.warn("Chat title generation failed", {
      threadId: args.threadId,
      err: result.error,
    });
  }
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

function sanitizeFollowup(raw: string): string | null {
  const text = raw
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > 120 ? `${text.slice(0, 117).trim()}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecommendedFollowupGenerationType(
  value: unknown,
): value is ChatMessageRecommendedFollowupGenerationType {
  return (
    value === "image" ||
    value === "video" ||
    value === "presentation" ||
    value === "website"
  );
}

function recommendedFollowupFromUnknown(
  value: unknown,
): ChatMessageRecommendedFollowup | null {
  const prompt = sanitizeFollowup(
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.prompt === "string"
        ? value.prompt
        : "",
  );
  if (prompt === null) {
    return null;
  }

  if (!isRecord(value) || value.kind !== "generate") {
    return { prompt, kind: "talk" };
  }

  return {
    prompt,
    kind: "generate",
    ...(isRecommendedFollowupGenerationType(value.generationType)
      ? { generationType: value.generationType }
      : {}),
  };
}

function parseRecommendedFollowups(
  text: string,
): ChatMessageRecommendedFollowups {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const fromJson = (() => {
    const parsed = safeJsonParse(unfenced);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  })();

  const candidates = fromJson ?? unfenced.split("\n");
  const seen = new Set<string>();
  const suggestions: ChatMessageRecommendedFollowups = [];
  for (const candidate of candidates) {
    const suggestion = recommendedFollowupFromUnknown(candidate);
    if (suggestion === null || seen.has(suggestion.prompt)) {
      continue;
    }
    seen.add(suggestion.prompt);
    suggestions.push(suggestion);
    if (suggestions.length >= FOLLOWUP_LIMIT) {
      break;
    }
  }
  return suggestions;
}

async function getLatestFollowupContextMessages(
  db: SelectDb,
  threadId: string,
): Promise<TitleContextMessage[]> {
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
  messages: readonly TitleContextMessage[],
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
          "Generate up to three concise follow-up prompts the user may ask next in this chat.",
          "Make them specific to the latest assistant reply, actionable, and useful. Match the user's language.",
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

export async function generateChatThreadRecommendedFollowups(args: {
  readonly db: SelectDb;
  readonly threadId: string;
}): Promise<ChatMessageRecommendedFollowups> {
  const result = await settle(
    (async () => {
      const messages = await getLatestFollowupContextMessages(
        args.db,
        args.threadId,
      );
      return generateRecommendedFollowups(messages);
    })(),
  );
  if (!result.ok) {
    log.warn("Recommended follow-up generation failed", {
      threadId: args.threadId,
      err: result.error,
    });
    return [];
  }
  return result.value;
}
