import {
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "./agent-run-create.service";
import type { ChatThreadSessionResolutionAction } from "./chat-session-continuity.service";
import { loadWebChatIncompleteContext } from "./zero-chat-incomplete-context.service";
import { visibleChatEventCondition } from "./zero-chat-event-shared.service";
import { chatEventTextCondition } from "./zero-chat-event-type.service";
import {
  type ChatAgentRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";

const RECENT_CHAT_RUN_LIMIT = 10;
const WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP = 4000;

interface WebChatPriorRunEvent {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
}

interface WebChatPriorRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly events: readonly WebChatPriorRunEvent[];
}

export interface WebChatSessionPromptContext {
  readonly generationTemplatePrompt: string;
  readonly computerUseHostDisplayName: string | null;
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
}

function buildWebChatPrompt(): string {
  return [
    "# Current Integration\nYou are currently running inside: Web",
    "You are communicating with the user through the web chat UI.",
  ].join("\n\n");
}

/**
 * Provenance for a run whose prompt arrived from an agent run in another chat
 * thread. The message text is all that crosses the thread boundary, so without
 * this block the run cannot tell that a person did not write it, and has no
 * identifier for the conversation it came from.
 *
 * These are facts about how the run was created, not instructions about what
 * to do with them. What the run needs from the source thread depends on the
 * message, so the commands are listed and the choice is left to the run.
 */
export function buildAgentRunSourceContext(
  source: ChatAgentRunSourceAnnotation,
): string {
  return [
    "# This Run's Trigger",
    "",
    "The message this run was created for was sent by an agent run in another chat thread. A person did not type it here.",
    "",
    `- SOURCE_RUN_ID: ${source.runId}`,
    `- SOURCE_THREAD_ID: ${source.threadId}`,
    `- SOURCE_AGENT_ID: ${source.agentId}`,
    `- SOURCE_THREAD_TITLE: ${source.titleSnapshot}`,
    "",
    "The message text is everything that run chose to carry across the thread boundary. Its own instructions, the conversation it came from, and whatever it already found stayed in the source thread and are not included above.",
    "",
    "Reading the source, each through ZERO_TOKEN:",
    `- \`zero chat messages --thread-id ${source.threadId}\` prints the source thread's user and assistant messages (chat-event:read)`,
    `- \`zero chat get --thread-id ${source.threadId}\` prints its title, agent, and model (chat-thread:read)`,
    `- \`zero logs ${source.runId} --all\` prints the full event stream of the run that sent this message (agent-run:read)`,
    "",
    `This run's output is appended to this thread, where the user reads it. Nothing carries it back to the source run. \`zero chat send --thread-id ${source.threadId}\` posts a new message into the source thread, which starts a run there.`,
  ].join("\n");
}

function buildComputerUseSystemPrompt(displayName: string): string {
  return [
    "# Computer Use",
    `Computer Use is enabled for this run on ${displayName}.`,
    "Use Zero CLI computer-use commands to inspect apps, read app state, and perform desktop actions.",
    "The computer may go offline while this run is active. If a command reports that the computer is unavailable or offline, ask the user to reconnect Zero Computer Use on that computer, then retry.",
  ].join("\n");
}

export function buildWebChatAppendSystemPrompt(args: {
  readonly incompleteContext: string;
  readonly priorContext: string;
  readonly context: WebChatSessionPromptContext;
}): string {
  return [
    buildWebChatPrompt(),
    args.context.agentRunSource
      ? buildAgentRunSourceContext(args.context.agentRunSource)
      : "",
    args.priorContext,
    args.incompleteContext,
    args.context.generationTemplatePrompt,
    args.context.computerUseHostDisplayName
      ? buildComputerUseSystemPrompt(args.context.computerUseHostDisplayName)
      : "",
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

function truncatePrior(value: string): string {
  if (value.length <= WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function formatPriorRunEvent(event: WebChatPriorRunEvent): string {
  const roleLabel = event.role === "user" ? "User" : "Assistant";
  const userMessage = requiredUserMessageForEvent(
    event.eventType,
    event.userMessage,
  );
  if (userMessage) {
    const prompt = projectUserMessage(userMessage).agentPrompt;
    return `${roleLabel}: ${truncatePrior(prompt) || "[empty message]"}`;
  }
  return `${roleLabel}: ${
    event.content === null
      ? "[empty message]"
      : truncatePrior(event.content) || "[empty message]"
  }`;
}

function buildWebChatPriorRunsContext(
  runs: readonly WebChatPriorRun[],
): string {
  if (runs.length === 0) {
    return "";
  }
  const total = runs.length;
  const blocks = runs.map((run, index) => {
    const relativeIndex = index - total + 1;
    const renderedEvents = run.events.map((event) => {
      return formatPriorRunEvent(event);
    });
    const hasUserEvent = run.events.some((event) => {
      return event.role === "user";
    });
    const hasAssistantEvent = run.events.some((event) => {
      return event.role === "assistant";
    });
    if (!hasUserEvent) {
      renderedEvents.unshift(
        `User: ${truncatePrior(run.prompt) || "[empty message]"}`,
      );
    }
    if (!hasAssistantEvent) {
      renderedEvents.push("Assistant: [no stored assistant message]");
    }
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_ID: ${run.runId}`,
      `- RUN_STATUS: ${run.status}`,
      `- LOG_COMMAND: zero logs ${run.runId} --all`,
      "",
      ...renderedEvents,
    ].join("\n");
  });
  return [
    "# Web Chat Run Context",
    "",
    "The runs below are from the same web chat thread. When responding:",
    "- Runs closer to RELATIVE_INDEX 0 are more recent -- prioritize them.",
    "- Match the tone of the conversation -- casual messages deserve casual replies.",
    "- Only provide technical analysis when explicitly asked a technical question.",
    "- Keep responses proportional to the message length and complexity.",
    "- Use the LOG_COMMAND for a run if you need more detailed agent log context.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

async function getLatestRunsByThreadId(
  db: Db,
  threadId: string,
): Promise<WebChatPriorRun[]> {
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
  const runIds = orderedRuns.map((run) => {
    return run.runId;
  });
  if (runIds.length === 0) {
    return [];
  }

  const eventRows = await db
    .select({
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      content: chatEvents.content,
      userMessage: chatEvents.userMessage,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTextCondition(),
        inArray(chatEvents.runId, runIds),
        visibleChatEventCondition(db),
      ),
    )
    .orderBy(asc(chatEvents.seqId));

  const eventsByRunId = new Map<string, WebChatPriorRunEvent[]>();
  for (const row of eventRows) {
    if (row.runId === null) {
      continue;
    }
    const existing = eventsByRunId.get(row.runId) ?? [];
    existing.push({
      eventType: row.eventType,
      role: chatEventCompatibilityRole(row.eventType),
      content: row.content,
      userMessage: row.userMessage,
    });
    eventsByRunId.set(row.runId, existing);
  }

  return orderedRuns.map((run) => {
    return {
      runId: run.runId,
      status: run.status,
      prompt: run.prompt,
      events: eventsByRunId.get(run.runId) ?? [],
    };
  });
}

export async function resolveWebChatSessionPrompt(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly sessionAction: ChatThreadSessionResolutionAction;
  readonly context: WebChatSessionPromptContext;
  readonly historyPolicy?: "default" | "none";
}): Promise<string> {
  const omitHistory = args.historyPolicy === "none";
  const incompleteContext =
    omitHistory || args.sessionAction === "rotated"
      ? ""
      : await loadWebChatIncompleteContext(args.db, args.threadId);
  const priorContext =
    omitHistory || incompleteContext.length > 0
      ? ""
      : buildWebChatPriorRunsContext(
          await getLatestRunsByThreadId(args.db, args.threadId),
        );
  return buildWebChatAppendSystemPrompt({
    incompleteContext,
    priorContext,
    context: args.context,
  });
}
