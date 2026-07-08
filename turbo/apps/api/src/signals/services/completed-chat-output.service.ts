import { chatOutputMaterializations } from "@vm0/db/schema/chat-output-materialization";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { delay } from "signal-timers";

import { waitForRunEventWatermarkVisibility } from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";
import { getDatasetName, queryAxiomDirect } from "../external/axiom";
import type { Db } from "../external/db";
import { settle } from "../utils";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const COMPLETED_CHAT_OUTPUT_RETRY_ATTEMPTS = 2;
const COMPLETED_CHAT_OUTPUT_RETRY_DELAY_MS = 500;

const COMPLETED_CHAT_OUTPUT_UNAVAILABLE_ERROR =
  "Completed run output was not visible before delivery timeout";

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
}

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
}

interface AxiomChatOutputEvent {
  readonly eventType?: string;
  readonly sequenceNumber?: number;
  readonly eventData?: {
    readonly message?: { readonly content?: readonly ContentBlock[] };
    readonly item?: CodexItem;
    readonly result?: string;
    readonly sequenceNumber?: number;
  };
}

export interface AssistantEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

export interface ResultEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

export type DbCompletedChatOutputState =
  | {
      readonly kind: "complete";
      readonly latestAssistantContent: string | null;
      readonly hasResultFallbackCandidate: boolean;
    }
  | { readonly kind: "incomplete" };

type CompletedChatOutputResolution =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "empty_after_complete_visibility" }
  | {
      readonly kind: "not_visible_yet";
      readonly reason:
        | "missing_last_event_sequence"
        | "db_incomplete"
        | "axiom_no_output";
    }
  | { readonly kind: "query_failed"; readonly error: unknown };

function extractAnthropicContent(
  blocks: readonly ContentBlock[],
): string | null {
  const parts = blocks.flatMap((block) => {
    return block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
      ? [block.text]
      : [];
  });
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function extractCodexAgentMessageContent(item: CodexItem): string | null {
  if (
    item.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function extractAssistantContent(event: AxiomChatOutputEvent): string | null {
  const content =
    event.eventType === "assistant" ? event.eventData?.message?.content : null;
  if (content) {
    return extractAnthropicContent(content);
  }
  const item =
    event.eventType === "item.completed" ? event.eventData?.item : null;
  if (item) {
    return extractCodexAgentMessageContent(item);
  }
  return null;
}

function extractResultFallback(
  sequenceNumber: number,
  event: AxiomChatOutputEvent,
): ResultEventItem | null {
  if (event.eventType !== "result") {
    return null;
  }

  const result = event.eventData?.result;
  if (typeof result !== "string") {
    return null;
  }
  if (!result.trim()) {
    return null;
  }
  return { sequenceNumber, content: result };
}

export async function queryChatOutputEvents(args: {
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<{
  readonly assistantItems: readonly AssistantEventItem[];
  readonly resultFallback: ResultEventItem | null;
  readonly watermarkVisible: boolean;
}> {
  args.signal.throwIfAborted();
  const visibility = await waitForRunEventWatermarkVisibility(
    args.runId,
    args.lastEventSequence,
    {
      sleep: (ms) => {
        return delay(ms, { signal: args.signal });
      },
    },
  );
  args.signal.throwIfAborted();
  const watermarkVisible =
    visibility.kind === "checked" ? visibility.visible : false;

  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const sequenceCap =
    args.lastEventSequence === null
      ? ""
      : `\n| where sequenceNumber <= ${args.lastEventSequence}`;
  const apl = `['${dataset}']
| where runId == "${escapeAplString(args.runId)}"
| where eventType == "assistant" or eventType == "result" or eventType == "item.completed"
${sequenceCap}
| order by sequenceNumber asc
| limit 200`;

  const events = await queryAxiomDirect<AxiomChatOutputEvent>(apl, {
    noCache: true,
  });
  args.signal.throwIfAborted();

  const assistantItems: AssistantEventItem[] = [];
  let resultFallback: ResultEventItem | null = null;
  for (const event of events) {
    const sequenceNumber =
      event.sequenceNumber ?? event.eventData?.sequenceNumber;
    if (typeof sequenceNumber !== "number") {
      continue;
    }
    if (
      args.lastEventSequence !== null &&
      sequenceNumber > args.lastEventSequence
    ) {
      continue;
    }

    const assistant = extractAssistantContent(event);
    if (assistant !== null) {
      assistantItems.push({ sequenceNumber, content: assistant });
      continue;
    }

    const fallback = extractResultFallback(sequenceNumber, event);
    if (fallback !== null) {
      resultFallback = fallback;
    }
  }

  return { assistantItems, resultFallback, watermarkVisible };
}

export async function latestEventBackedAssistantMessage(
  db: Db,
  runId: string,
  options: { readonly maxSequenceNumber?: number } = {},
): Promise<{ readonly content: string } | null> {
  const [message] = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.sequenceNumber),
        isNotNull(chatMessages.content),
        sql<boolean>`NOT (${chatMessages.content} ~ '^[[:space:]]*$')`,
        ...(options.maxSequenceNumber === undefined
          ? []
          : [lte(chatMessages.sequenceNumber, options.maxSequenceNumber)]),
      ),
    )
    .orderBy(desc(chatMessages.sequenceNumber))
    .limit(1);

  if (!message || message.content === null) {
    return null;
  }
  return { content: message.content };
}

export async function loadDbCompletedChatOutputState(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
}): Promise<DbCompletedChatOutputState> {
  if (args.lastEventSequence === null) {
    return { kind: "incomplete" };
  }

  const [state] = await args.db
    .select({
      processedThroughSequence:
        chatOutputMaterializations.processedThroughSequence,
      latestResultSequence: chatOutputMaterializations.latestResultSequence,
    })
    .from(chatOutputMaterializations)
    .where(eq(chatOutputMaterializations.runId, args.runId))
    .limit(1);

  if (!state || state.processedThroughSequence < args.lastEventSequence) {
    return { kind: "incomplete" };
  }

  const latestAssistant = await latestEventBackedAssistantMessage(
    args.db,
    args.runId,
    { maxSequenceNumber: args.lastEventSequence },
  );
  return {
    kind: "complete",
    latestAssistantContent: latestAssistant?.content ?? null,
    hasResultFallbackCandidate:
      state.latestResultSequence !== null &&
      state.latestResultSequence <= args.lastEventSequence,
  };
}

function latestAssistantText(
  assistantItems: readonly AssistantEventItem[],
): string | null {
  return assistantItems.length > 0
    ? assistantItems[assistantItems.length - 1]!.content
    : null;
}

async function resolveCompletedChatOutputOnce(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<CompletedChatOutputResolution> {
  const dbOutputState = await loadDbCompletedChatOutputState({
    db: args.db,
    runId: args.runId,
    lastEventSequence: args.lastEventSequence,
  });
  args.signal.throwIfAborted();

  if (
    dbOutputState.kind === "complete" &&
    dbOutputState.latestAssistantContent !== null
  ) {
    return { kind: "ready", text: dbOutputState.latestAssistantContent };
  }

  if (
    dbOutputState.kind === "complete" &&
    !dbOutputState.hasResultFallbackCandidate
  ) {
    return { kind: "empty_after_complete_visibility" };
  }

  const axiomOutput = await queryChatOutputEvents({
    runId: args.runId,
    lastEventSequence: args.lastEventSequence,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const assistantText = latestAssistantText(axiomOutput.assistantItems);
  if (assistantText !== null) {
    return { kind: "ready", text: assistantText };
  }
  if (axiomOutput.resultFallback !== null) {
    return { kind: "ready", text: axiomOutput.resultFallback.content };
  }
  if (dbOutputState.kind === "complete") {
    return dbOutputState.hasResultFallbackCandidate
      ? { kind: "not_visible_yet", reason: "axiom_no_output" }
      : { kind: "empty_after_complete_visibility" };
  }
  if (args.lastEventSequence !== null && axiomOutput.watermarkVisible) {
    return { kind: "empty_after_complete_visibility" };
  }
  return {
    kind: "not_visible_yet",
    reason:
      args.lastEventSequence === null
        ? "missing_last_event_sequence"
        : "db_incomplete",
  };
}

async function resolveCompletedChatOutput(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<CompletedChatOutputResolution> {
  const result = await settle(
    resolveCompletedChatOutputOnce(args),
    args.signal,
  );
  if (result.ok) {
    return result.value;
  }
  return { kind: "query_failed", error: result.error };
}

export async function resolveCompletedChatOutputWithRetry(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}): Promise<CompletedChatOutputResolution> {
  const maxAttempts = args.maxAttempts ?? COMPLETED_CHAT_OUTPUT_RETRY_ATTEMPTS;
  const retryDelayMs =
    args.retryDelayMs ?? COMPLETED_CHAT_OUTPUT_RETRY_DELAY_MS;
  let lastResult: CompletedChatOutputResolution = {
    kind: "not_visible_yet",
    reason: "axiom_no_output",
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await resolveCompletedChatOutput(args);
    if (lastResult.kind !== "not_visible_yet") {
      return lastResult;
    }
    if (attempt + 1 >= maxAttempts) {
      break;
    }

    args.signal.throwIfAborted();
    await delay(retryDelayMs, { signal: args.signal });
    args.signal.throwIfAborted();
  }

  return lastResult;
}

export function completedChatOutputFailureMessage(
  result: Extract<
    CompletedChatOutputResolution,
    { readonly kind: "not_visible_yet" } | { readonly kind: "query_failed" }
  >,
): string {
  if (result.kind === "query_failed") {
    const detail =
      result.error instanceof Error ? `: ${result.error.message}` : "";
    return `${COMPLETED_CHAT_OUTPUT_UNAVAILABLE_ERROR}: query_failed${detail}`;
  }
  return `${COMPLETED_CHAT_OUTPUT_UNAVAILABLE_ERROR}: ${result.reason}`;
}
