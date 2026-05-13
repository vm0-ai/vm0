import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { publishThreadListChanged } from "../external/realtime";
import type { Db } from "../external/db";
import { safeAsync } from "../utils";
import { visibleChatMessageCondition } from "./zero-chat-thread.service";

const log = logger("api:zero:chat-title");
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const TITLE_MODEL = "google/gemini-3.1-flash-lite-preview";
const TITLE_CONTEXT_CHAR_CAP = 150;
const TITLE_PRIOR_MESSAGE_CAP = 10;

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
      model: TITLE_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => {
      return "unknown error";
    });
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }

  return stripMarkdown(content);
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
  const result = await safeAsync(async () => {
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
  });
  if ("error" in result) {
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
  const result = await safeAsync(async () => {
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
  });
  if ("error" in result) {
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
