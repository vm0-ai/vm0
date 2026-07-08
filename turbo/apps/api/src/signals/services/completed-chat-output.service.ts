import { chatOutputMaterializations } from "@vm0/db/schema/chat-output-materialization";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { delay } from "signal-timers";

import { waitForRunEventWatermarkVisibility } from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";
import {
  getDatasetName,
  queryAxiomDirect,
  type QueryAxiomOptions,
} from "../external/axiom";
import type { Db } from "../external/db";
import { settle } from "../utils";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const COMPLETED_CHAT_OUTPUT_RETRY_ATTEMPTS = 2;
const COMPLETED_CHAT_OUTPUT_MISSING_WATERMARK_RETRY_ATTEMPTS = 4;
const COMPLETED_CHAT_OUTPUT_RETRY_DELAY_MS = 500;
const COMPLETED_CHAT_OUTPUT_AXIOM_QUERY_TIMEOUT_MS = 5000;
const LATEST_OUTPUT_EVENT_LIMIT = 200;

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

type ChatOutputVisibility = { readonly watermarkVisible: boolean };

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

function freshAxiomOptions(signal: AbortSignal): QueryAxiomOptions {
  return {
    noCache: true,
    signal,
    timeoutMs: COMPLETED_CHAT_OUTPUT_AXIOM_QUERY_TIMEOUT_MS,
  };
}

async function waitForChatOutputVisibility(args: {
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<ChatOutputVisibility> {
  args.signal.throwIfAborted();
  const visibility = await waitForRunEventWatermarkVisibility(
    args.runId,
    args.lastEventSequence,
    {
      sleep: (ms) => {
        return delay(ms, { signal: args.signal });
      },
      queryAxiomFn: (apl, options) => {
        return queryAxiomDirect(apl, {
          ...options,
          signal: args.signal,
          timeoutMs: COMPLETED_CHAT_OUTPUT_AXIOM_QUERY_TIMEOUT_MS,
        });
      },
    },
  );
  args.signal.throwIfAborted();
  const watermarkVisible =
    visibility.kind === "checked" ? visibility.visible : false;
  return { watermarkVisible };
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
  const { watermarkVisible } = await waitForChatOutputVisibility(args);
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

  const events = await queryAxiomDirect<AxiomChatOutputEvent>(
    apl,
    freshAxiomOptions(args.signal),
  );
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

async function queryLatestChatOutput(args: {
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<{
  readonly text: string | null;
  readonly watermarkVisible: boolean;
}> {
  const { watermarkVisible } = await waitForChatOutputVisibility(args);
  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const sequenceCap =
    args.lastEventSequence === null
      ? ""
      : `\n| where sequenceNumber <= ${args.lastEventSequence}`;
  const apl = `['${dataset}']
| where runId == "${escapeAplString(args.runId)}"
| where eventType == "assistant" or eventType == "result" or (eventType == "item.completed" and ['eventData.item.type'] == "agent_message")
${sequenceCap}
| order by sequenceNumber desc
| limit ${LATEST_OUTPUT_EVENT_LIMIT}`;

  const events = await queryAxiomDirect<AxiomChatOutputEvent>(
    apl,
    freshAxiomOptions(args.signal),
  );
  args.signal.throwIfAborted();

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
      return { text: assistant, watermarkVisible };
    }

    const fallback = extractResultFallback(sequenceNumber, event);
    if (fallback !== null) {
      return { text: fallback.content, watermarkVisible };
    }
  }

  return { text: null, watermarkVisible };
}

async function queryLatestTerminalResult(args: {
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const apl = `['${dataset}']
| where runId == "${escapeAplString(args.runId)}"
| where eventType == "result"
| order by sequenceNumber desc
| limit 1`;

  const events = await queryAxiomDirect<AxiomChatOutputEvent>(
    apl,
    freshAxiomOptions(args.signal),
  );
  args.signal.throwIfAborted();

  for (const event of events) {
    const sequenceNumber =
      event.sequenceNumber ?? event.eventData?.sequenceNumber;
    if (typeof sequenceNumber !== "number") {
      continue;
    }
    const fallback = extractResultFallback(sequenceNumber, event);
    if (fallback !== null) {
      return fallback.content;
    }
  }

  return null;
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

async function loadRunLastEventSequence(
  db: Db,
  runId: string,
): Promise<number | null> {
  const [run] = await db
    .select({ lastEventSequence: agentRuns.lastEventSequence })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run?.lastEventSequence ?? null;
}

async function hasNewerLastEventSequence(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  if (args.lastEventSequence === null) {
    return false;
  }
  const persistedLastEventSequence = await loadRunLastEventSequence(
    args.db,
    args.runId,
  );
  args.signal.throwIfAborted();
  return (
    persistedLastEventSequence !== null &&
    persistedLastEventSequence > args.lastEventSequence
  );
}

async function resolveCompletedChatOutputOnce(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly allowUnwatermarkedTerminalResult: boolean;
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
    if (await hasNewerLastEventSequence(args)) {
      return { kind: "not_visible_yet", reason: "axiom_no_output" };
    }
    return { kind: "empty_after_complete_visibility" };
  }

  if (args.lastEventSequence === null) {
    if (args.allowUnwatermarkedTerminalResult) {
      const terminalResult = await queryLatestTerminalResult({
        runId: args.runId,
        signal: args.signal,
      });
      if (terminalResult !== null) {
        return { kind: "ready", text: terminalResult };
      }
    }
    return {
      kind: "not_visible_yet",
      reason: "missing_last_event_sequence",
    };
  }

  const axiomOutput = await queryLatestChatOutput({
    runId: args.runId,
    lastEventSequence: args.lastEventSequence,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  if (axiomOutput.text !== null) {
    return { kind: "ready", text: axiomOutput.text };
  }
  if (dbOutputState.kind === "complete") {
    if (
      !dbOutputState.hasResultFallbackCandidate &&
      (await hasNewerLastEventSequence(args))
    ) {
      return { kind: "not_visible_yet", reason: "axiom_no_output" };
    }
    return dbOutputState.hasResultFallbackCandidate
      ? { kind: "not_visible_yet", reason: "axiom_no_output" }
      : { kind: "empty_after_complete_visibility" };
  }
  if (args.lastEventSequence !== null && axiomOutput.watermarkVisible) {
    if (await hasNewerLastEventSequence(args)) {
      return { kind: "not_visible_yet", reason: "axiom_no_output" };
    }
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
  readonly allowUnwatermarkedTerminalResult: boolean;
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
  const maxMissingWatermarkAttempts =
    args.maxAttempts ?? COMPLETED_CHAT_OUTPUT_MISSING_WATERMARK_RETRY_ATTEMPTS;
  const maxWatermarkedAttempts =
    args.maxAttempts ?? COMPLETED_CHAT_OUTPUT_RETRY_ATTEMPTS;
  const retryDelayMs =
    args.retryDelayMs ?? COMPLETED_CHAT_OUTPUT_RETRY_DELAY_MS;
  let lastEventSequence = args.lastEventSequence;
  let lastResult: CompletedChatOutputResolution = {
    kind: "not_visible_yet",
    reason: "axiom_no_output",
  };
  let missingWatermarkAttempts = 0;
  let watermarkedAttempts = 0;

  for (;;) {
    const persistedLastEventSequence = await loadRunLastEventSequence(
      args.db,
      args.runId,
    );
    args.signal.throwIfAborted();
    if (
      persistedLastEventSequence !== null &&
      (lastEventSequence === null ||
        persistedLastEventSequence > lastEventSequence)
    ) {
      if (lastEventSequence !== null) {
        watermarkedAttempts = 0;
      }
      lastEventSequence = persistedLastEventSequence;
    }

    const hasWatermark = lastEventSequence !== null;
    if (hasWatermark) {
      watermarkedAttempts++;
    } else {
      missingWatermarkAttempts++;
    }

    lastResult = await resolveCompletedChatOutput({
      db: args.db,
      runId: args.runId,
      lastEventSequence,
      allowUnwatermarkedTerminalResult:
        !hasWatermark &&
        missingWatermarkAttempts >= maxMissingWatermarkAttempts,
      signal: args.signal,
    });
    if (
      lastResult.kind !== "not_visible_yet" &&
      lastResult.kind !== "query_failed"
    ) {
      return lastResult;
    }

    const refreshedLastEventSequence = await loadRunLastEventSequence(
      args.db,
      args.runId,
    );
    args.signal.throwIfAborted();
    if (
      refreshedLastEventSequence !== null &&
      (lastEventSequence === null ||
        refreshedLastEventSequence > lastEventSequence)
    ) {
      if (lastEventSequence !== null) {
        watermarkedAttempts = 0;
      }
      lastEventSequence = refreshedLastEventSequence;
      continue;
    }

    const attempts = hasWatermark
      ? watermarkedAttempts
      : missingWatermarkAttempts;
    const maxAttempts = hasWatermark
      ? maxWatermarkedAttempts
      : maxMissingWatermarkAttempts;
    if (attempts >= maxAttempts) {
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
