import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
} from "@vm0/api-contracts/contracts/chat-events";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "./agent-run-create.service";
import type { ChatThreadSessionResolutionAction } from "./chat-session-continuity.service";
import { loadWebChatIncompleteContext } from "./zero-chat-incomplete-context.service";
import {
  chatEventTypeIn,
  chatEventTypeSql,
} from "./zero-chat-event-type.service";
import { visibleChatEventCondition } from "./zero-chat-message-shared.service";
import { projectUserMessage } from "./zero-chat-user-message.service";

const RECENT_CHAT_RUN_LIMIT = 10;
const PRIOR_MESSAGE_CHAR_CAP = 4000;
const FULL_CHAT_RUN_CONTEXT_BYTE_LIMIT = 16 * 1024;
const CONTEXT_BUDGET_TRUNCATION_MARKER =
  "\n[Transcript truncated to fit the chat context budget.]";

export type ChatRunContextTriggerSource = "web" | "slack" | "feishu" | "teams";

export interface ChatRunContextRequest {
  readonly triggerSource: ChatRunContextTriggerSource;
  readonly inlineTemplatesEnabled: boolean;
}

interface RecentRunMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly userMessage: UserMessageDocument | null;
  readonly attachFiles: readonly string[] | null;
}

interface RecentRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly messages: readonly RecentRunMessage[];
}

function triggerSourceName(source: ChatRunContextTriggerSource): string {
  switch (source) {
    case "web": {
      return "Web Chat";
    }
    case "slack": {
      return "Slack";
    }
    case "feishu": {
      return "Feishu";
    }
    case "teams": {
      return "Microsoft Teams";
    }
  }
}

function truncatePriorMessage(value: string): string {
  if (value.length <= PRIOR_MESSAGE_CHAR_CAP) {
    return value;
  }
  let prefix = value.slice(0, PRIOR_MESSAGE_CHAR_CAP);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 55_296 && lastCodeUnit <= 56_319) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}...[truncated]`;
}

function truncateUtf8WithMarker(value: string, byteLimit: number): string {
  const markerBytes = Buffer.byteLength(
    CONTEXT_BUDGET_TRUNCATION_MARKER,
    "utf8",
  );
  if (byteLimit <= markerBytes) {
    return "";
  }

  const parts: string[] = [];
  let usedBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (usedBytes + codePointBytes + markerBytes > byteLimit) {
      break;
    }
    parts.push(codePoint);
    usedBytes += codePointBytes;
  }
  if (parts.length === 0) {
    return "";
  }
  return `${parts.join("")}${CONTEXT_BUDGET_TRUNCATION_MARKER}`;
}

function formatAttachFileIds(
  ids: readonly string[] | null | undefined,
): string {
  if (!ids || ids.length === 0) {
    return "";
  }
  return ids
    .map((id) => {
      return `[Web file]\n   [ID] ${id}`;
    })
    .join("\n");
}

function formatRecentRunMessage(
  message: RecentRunMessage,
  request: ChatRunContextRequest,
): string {
  const roleLabel = message.role === "user" ? "User" : "Assistant";
  if (message.role === "user" && message.userMessage) {
    const prompt = projectUserMessage(message.userMessage, {
      inlineTemplates: request.inlineTemplatesEnabled,
    }).agentPrompt;
    return `${roleLabel}: ${truncatePriorMessage(prompt) || "[empty message]"}`;
  }
  const attach = formatAttachFileIds(message.attachFiles);
  const body = `${roleLabel}: ${
    truncatePriorMessage(message.content) || "[empty message]"
  }`;
  return attach ? `${body}\n${attach}` : body;
}

function formatRunMetadata(
  run: RecentRun,
  index: number,
  total: number,
): string {
  return [
    "---",
    "",
    `- RELATIVE_INDEX: ${index - total + 1}`,
    `- RUN_ID: ${run.runId}`,
    `- RUN_STATUS: ${run.status}`,
    `- LOG_COMMAND: zero logs ${run.runId} --all`,
  ].join("\n");
}

function formatRunTranscript(
  run: RecentRun,
  request: ChatRunContextRequest,
): string {
  const messages = run.messages.map((message) => {
    return formatRecentRunMessage(message, request);
  });
  const hasUserMessage = run.messages.some((message) => {
    return message.role === "user";
  });
  const hasAssistantMessage = run.messages.some((message) => {
    return message.role === "assistant";
  });
  if (!hasUserMessage) {
    messages.unshift(
      `User: ${truncatePriorMessage(run.prompt) || "[empty message]"}`,
    );
  }
  if (!hasAssistantMessage) {
    messages.push("Assistant: [no stored assistant message]");
  }
  return messages.join("\n");
}

function renderRunContext(
  header: readonly string[],
  runs: readonly RecentRun[],
  transcripts: readonly (string | undefined)[],
): string {
  const blocks = runs.map((run, index) => {
    const metadata = formatRunMetadata(run, index, runs.length);
    const transcript = transcripts[index];
    return transcript ? `${metadata}\n\n${transcript}` : metadata;
  });
  return [...header, "", blocks.join("\n\n"), "", "---"].join("\n");
}

function buildMetadataContext(
  runs: readonly RecentRun[],
  request: ChatRunContextRequest,
): string {
  if (runs.length === 0) {
    return "";
  }
  return renderRunContext(
    [
      `# ${triggerSourceName(request.triggerSource)} Run Metadata`,
      "",
      "The compatible CLI session already contains the completed conversation history.",
      "The runs below are retained only for ordering, status, and log retrieval.",
      "- RELATIVE_INDEX 0 is the most recent prior run.",
      "- Use the LOG_COMMAND only when more detailed run context is needed.",
    ],
    runs,
    [],
  );
}

function buildFullContext(
  runs: readonly RecentRun[],
  request: ChatRunContextRequest,
): string {
  if (runs.length === 0) {
    return "";
  }
  const header = [
    `# ${triggerSourceName(request.triggerSource)} Run Context`,
    "",
    "The current CLI session is fresh, so recent visible chat rounds are provided here for continuity.",
    "When responding:",
    "- Runs closer to RELATIVE_INDEX 0 are more recent -- prioritize them.",
    "- Match the tone of the conversation -- casual messages deserve casual replies.",
    "- Only provide technical analysis when explicitly asked a technical question.",
    "- Keep responses proportional to the message length and complexity.",
    "- Use the LOG_COMMAND for a run if you need more detailed agent log context.",
  ];
  const transcripts: (string | undefined)[] = [];
  let context = renderRunContext(header, runs, transcripts);
  if (Buffer.byteLength(context, "utf8") > FULL_CHAT_RUN_CONTEXT_BYTE_LIMIT) {
    throw new Error("Chat run metadata exceeds the full context byte limit");
  }

  const newestFirst = runs
    .map((run, index) => {
      return { index, run };
    })
    .reverse();
  for (const { index, run } of newestFirst) {
    const transcript = formatRunTranscript(run, request);
    transcripts[index] = transcript;
    const candidate = renderRunContext(header, runs, transcripts);
    if (
      Buffer.byteLength(candidate, "utf8") <= FULL_CHAT_RUN_CONTEXT_BYTE_LIMIT
    ) {
      context = candidate;
      continue;
    }

    transcripts[index] = undefined;
    const availableBytes =
      FULL_CHAT_RUN_CONTEXT_BYTE_LIMIT -
      Buffer.byteLength(context, "utf8") -
      Buffer.byteLength("\n\n", "utf8");
    const truncated = truncateUtf8WithMarker(transcript, availableBytes);
    if (truncated.length > 0) {
      transcripts[index] = truncated;
      context = renderRunContext(header, runs, transcripts);
    }
    break;
  }

  return context;
}

async function loadRecentRuns(
  db: Db,
  threadId: string,
  includeMessages: boolean,
): Promise<RecentRun[]> {
  const runRows = await db
    .select({
      runId: zeroRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        or(
          sql`${agentRuns.status} IS DISTINCT FROM ${"cancelled"}`,
          sql`${agentRuns.error} IS DISTINCT FROM ${BEFORE_DISPATCH_CANCELLED_ERROR}`,
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(RECENT_CHAT_RUN_LIMIT);

  const orderedRuns = runRows.reverse();
  if (!includeMessages || orderedRuns.length === 0) {
    return orderedRuns.map((run) => {
      return { ...run, messages: [] };
    });
  }

  const runIds = orderedRuns.map((run) => {
    return run.runId;
  });
  const messageRows = await db
    .select({
      runId: chatMessages.runId,
      eventType: chatEventTypeSql().as("event_type"),
      content: chatMessages.content,
      userMessage: chatMessages.userMessage,
      attachFiles: chatMessages.attachFiles,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        isNotNull(chatMessages.content),
        inArray(chatMessages.runId, runIds),
        chatEventTypeIn(CHAT_EVENT_TYPES),
        visibleChatEventCondition(db),
      ),
    )
    .orderBy(asc(chatMessages.seqId));

  const messagesByRunId = new Map<string, RecentRunMessage[]>();
  for (const row of messageRows) {
    if (row.runId === null || row.content === null) {
      continue;
    }
    const messages = messagesByRunId.get(row.runId) ?? [];
    messages.push({
      role: chatEventCompatibilityRole(row.eventType),
      content: row.content,
      userMessage: row.userMessage,
      attachFiles: row.attachFiles,
    });
    messagesByRunId.set(row.runId, messages);
  }

  return orderedRuns.map((run) => {
    return {
      ...run,
      messages: messagesByRunId.get(run.runId) ?? [],
    };
  });
}

export async function loadChatRunContext(
  db: Db,
  args: {
    readonly threadId: string;
    readonly resolutionAction: ChatThreadSessionResolutionAction;
    readonly resumableHistoryAvailable: boolean;
    readonly request: ChatRunContextRequest;
  },
): Promise<string> {
  if (
    args.resumableHistoryAvailable &&
    (args.resolutionAction === "reused" || args.resolutionAction === "adopted")
  ) {
    if (args.request.triggerSource === "web") {
      const incompleteContext = await loadWebChatIncompleteContext(
        db,
        args.threadId,
        args.request.inlineTemplatesEnabled,
      );
      if (incompleteContext.length > 0) {
        return incompleteContext;
      }
    }
    return buildMetadataContext(
      await loadRecentRuns(db, args.threadId, false),
      args.request,
    );
  }

  return buildFullContext(
    await loadRecentRuns(db, args.threadId, true),
    args.request,
  );
}
