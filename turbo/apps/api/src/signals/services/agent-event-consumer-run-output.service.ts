import {
  outputToolPayloadSchema,
  type OutputToolPayload,
} from "@okouai/api-contracts/contracts/chat-events";
import { command } from "ccstate";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import {
  insertAssistantEventsInTransaction,
  type InsertAssistantEventsInput,
} from "./chat-event-shared.service";
import {
  publishFirstAssistantEventCreatedSignalSafely,
  recordFirstAssistantEventAcknowledgementMetric,
} from "./chat-first-assistant-event-metric.service";
import { chatThreadForRunFromDb } from "./chat-thread.service";
import { writeRunMetadataInTransaction } from "./agent-run-metadata-write.service";
import {
  normalizeAgentToolEvent,
  terminalToolSummary,
} from "./agent-tool-event-normalization";
import {
  toolUseIdForProviderOperation,
  toolUseIdForRunEvent,
} from "./assistant-event-id";

const RUN_OUTPUT_PROJECTION_LOCK_TIMEOUT = "1s";
const RUN_OUTPUT_PROJECTION_STATEMENT_TIMEOUT = "5s";
interface OutputCandidate {
  readonly sequenceNumber: number;
  readonly content: string;
}

type ToolOperationState = Pick<
  OutputToolPayload,
  "action" | "status" | "summary"
>;

export interface MaterializedChatProjection {
  readonly thread: {
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
  };
  readonly insertedRowCount: number;
  readonly firstAssistantAcknowledgement: {
    readonly apiStartedAt: number;
    readonly acknowledgedAt: number;
  } | null;
}

export class AgentEventRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is missing during output materialization`);
    this.name = "AgentEventRunNotFoundError";
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function anthropicMessageText(event: AgentEvent): string | null {
  if (event.type !== "assistant") {
    return null;
  }

  const message = recordOf(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = recordOf(block);
    if (
      record?.type === "text" &&
      typeof record.text === "string" &&
      record.text.trim().length > 0
    ) {
      parts.push(record.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function codexAgentMessageText(event: AgentEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (
    item?.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function assistantMessageText(event: AgentEvent): string | null {
  return anthropicMessageText(event) ?? codexAgentMessageText(event);
}

function codexReasoningText(event: AgentEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (
    item?.type !== "reasoning" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function resultText(event: AgentEvent): string | null {
  if (event.type !== "result") {
    return null;
  }

  const directResult = event.result;
  if (typeof directResult === "string" && directResult.trim().length > 0) {
    return directResult;
  }

  const eventData = recordOf(event.eventData);
  const nestedResult = eventData?.result;
  if (typeof nestedResult === "string" && nestedResult.trim().length > 0) {
    return nestedResult;
  }

  return null;
}

function callbackOutputText(event: AgentEvent): string | null {
  return resultText(event) ?? codexAgentMessageText(event);
}

function latestCandidate(
  events: readonly AgentEvent[],
  extractText: (event: AgentEvent) => string | null,
): OutputCandidate | null {
  let latest: OutputCandidate | null = null;
  for (const event of events) {
    const content = extractText(event);
    if (content === null) {
      continue;
    }
    if (latest === null || event.sequenceNumber > latest.sequenceNumber) {
      latest = {
        sequenceNumber: event.sequenceNumber,
        content,
      };
    }
  }
  return latest;
}

function eventOutputId(event: AgentEvent): string {
  const item = recordOf(event.item);
  if (typeof item?.id === "string") {
    return item.id;
  }

  return `event:${event.sequenceNumber}`;
}

function toolRunEventId(sequenceNumber: number): string {
  return `tool:event:${sequenceNumber}`;
}

function assistantEventItems(args: {
  readonly events: readonly AgentEvent[];
  readonly runId: string;
  readonly framework: AgentRunLaunchSnapshot["framework"] | null;
  readonly toolActivityEnabled: boolean;
  readonly priorToolOperations: ReadonlyMap<string, ToolOperationState>;
}): InsertAssistantEventsInput["items"] {
  const items: InsertAssistantEventsInput["items"][number][] = [];
  const toolOperations = new Map(args.priorToolOperations);
  const events = [...args.events].sort((left, right) => {
    return left.sequenceNumber - right.sequenceNumber;
  });
  for (const event of events) {
    const messageText = assistantMessageText(event);
    if (messageText !== null) {
      items.push({
        eventType: "output.message",
        runEventSequenceNumber: event.sequenceNumber,
        content: messageText,
        runEventId: eventOutputId(event),
      });
      continue;
    }

    const reasoningText = codexReasoningText(event);
    if (reasoningText !== null) {
      items.push({
        eventType: "output.thinking",
        runEventSequenceNumber: event.sequenceNumber,
        thinking: reasoningText,
        runEventId: eventOutputId(event),
      });
      continue;
    }

    if (!args.toolActivityEnabled) {
      continue;
    }
    const normalized = normalizeAgentToolEvent(event, args.framework);
    if (normalized === null) {
      continue;
    }

    const runEventId = toolRunEventId(event.sequenceNumber);
    if (normalized.kind === "standalone") {
      const toolUseId = toolUseIdForRunEvent(args.runId, runEventId);
      items.push({
        eventType: "output.tool",
        runEventSequenceNumber: event.sequenceNumber,
        runEventId,
        toolUseId,
        action: normalized.action,
        status: normalized.status,
        summary: normalized.summary,
      });
      toolOperations.set(toolUseId, {
        action: normalized.action,
        status: normalized.status,
        summary: normalized.summary,
      });
      continue;
    }

    const toolUseId = toolUseIdForProviderOperation(
      args.runId,
      normalized.provider,
      normalized.providerOperationId,
    );
    const prior = toolOperations.get(toolUseId);
    if (normalized.kind === "correlated-terminal") {
      if (
        normalized.requiresPendingOperation === true &&
        prior?.status !== "pending"
      ) {
        continue;
      }
      const sourceOperation =
        prior ??
        (normalized.standaloneOperation === undefined
          ? undefined
          : {
              ...normalized.standaloneOperation,
              status: normalized.status,
            });
      if (sourceOperation === undefined) {
        continue;
      }
      const operation: ToolOperationState = {
        action: sourceOperation.action,
        status: normalized.status,
        summary:
          sourceOperation.status === "pending"
            ? terminalToolSummary(
                sourceOperation.action,
                sourceOperation.summary,
              )
            : sourceOperation.summary,
      };
      items.push({
        eventType: "output.tool",
        runEventSequenceNumber: event.sequenceNumber,
        runEventId,
        toolUseId,
        action: operation.action,
        status: operation.status,
        summary: operation.summary,
      });
      toolOperations.set(toolUseId, operation);
      continue;
    }

    const operation = {
      action: normalized.action,
      status: normalized.status,
      summary: normalized.summary,
    };
    items.push({
      eventType: "output.tool",
      runEventSequenceNumber: event.sequenceNumber,
      runEventId,
      toolUseId,
      action: operation.action,
      status: operation.status,
      summary: operation.summary,
    });
    toolOperations.set(toolUseId, operation);
  }
  return items;
}

async function priorToolOperationsForRun(
  tx: Tx,
  runId: string,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ToolOperationState>> {
  const rows = await tx
    .select({ payload: chatEvents.payload })
    .from(chatEvents)
    .where(
      and(eq(chatEvents.runId, runId), eq(chatEvents.eventType, "output.tool")),
    )
    .orderBy(asc(chatEvents.seqId));
  signal.throwIfAborted();

  const operations = new Map<string, ToolOperationState>();
  for (const row of rows) {
    const payload = outputToolPayloadSchema.parse(row.payload);
    operations.set(payload.toolUseId, {
      action: payload.action,
      status: payload.status,
      summary: payload.summary,
    });
  }
  return operations;
}

interface AssistantEventInsertion {
  readonly insertedRowCount: number;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}

async function insertRunOutputChatEvents(
  tx: Tx,
  payload: EventConsumerPayload,
  thread: MaterializedChatProjection["thread"],
  signal: AbortSignal,
): Promise<AssistantEventInsertion> {
  const [run] = await tx
    .select({
      chatToolActivityEnabled: agentRuns.chatToolActivityEnabled,
      launchSnapshot: agentRuns.launchSnapshot,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, payload.runId))
    .limit(1);
  signal.throwIfAborted();
  if (run === undefined) {
    throw new Error(
      `Run ${payload.runId} is missing during output materialization`,
    );
  }
  const toolActivityEnabled = run.chatToolActivityEnabled;
  const priorToolOperations = toolActivityEnabled
    ? await priorToolOperationsForRun(tx, payload.runId, signal)
    : new Map<string, ToolOperationState>();
  const assistantItems = assistantEventItems({
    events: payload.events,
    runId: payload.runId,
    framework: run.launchSnapshot?.framework ?? null,
    toolActivityEnabled,
    priorToolOperations,
  });
  return await insertAssistantEventsInTransaction(
    tx,
    {
      runId: payload.runId,
      threadId: thread.chatThreadId,
      userId: thread.userId,
      orgId: thread.orgId,
      items: assistantItems,
    },
    signal,
  );
}

async function lockRunOutputProjection(
  tx: Tx,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${RUN_OUTPUT_PROJECTION_LOCK_TIMEOUT}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${RUN_OUTPUT_PROJECTION_STATEMENT_TIMEOUT}, true)`,
  );
  const lockKey = `run_output_projection:${runId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  signal.throwIfAborted();
}

async function lockAgentRunForOutputMaterialization(
  tx: Tx,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const [run] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("key share")
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    throw new AgentEventRunNotFoundError(runId);
  }
}

async function materializeRunOutputEvents(
  writeDb: Db,
  payload: EventConsumerPayload,
  signal: AbortSignal,
): Promise<MaterializedChatProjection | null> {
  const latestResult = latestCandidate(payload.events, resultText);
  const latestOutput = latestCandidate(payload.events, callbackOutputText);

  return await writeDb.transaction(async (tx) => {
    await lockRunOutputProjection(tx, payload.runId, signal);
    await lockAgentRunForOutputMaterialization(tx, payload.runId, signal);

    const thread = await chatThreadForRunFromDb(tx, payload.runId);
    signal.throwIfAborted();

    let insertedRowCount = 0;
    let shouldAttemptFirstAssistantEventClaim = false;
    if (thread) {
      const insertion = await insertRunOutputChatEvents(
        tx,
        payload,
        thread,
        signal,
      );
      insertedRowCount = insertion.insertedRowCount;
      shouldAttemptFirstAssistantEventClaim =
        insertion.shouldAttemptFirstAssistantEventClaim;
    }

    if (latestResult !== null || latestOutput !== null) {
      const updatedAt = nowDate();
      await tx
        .insert(runOutputMaterializations)
        .values({
          runId: payload.runId,
          latestResultSequence: latestResult?.sequenceNumber,
          latestResultText: latestResult?.content,
          latestOutputSequence: latestOutput?.sequenceNumber,
          latestOutputText: latestOutput?.content,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: runOutputMaterializations.runId,
          set: {
            latestResultSequence:
              latestResult === null
                ? runOutputMaterializations.latestResultSequence
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.sequenceNumber} else ${runOutputMaterializations.latestResultSequence} end`,
            latestResultText:
              latestResult === null
                ? runOutputMaterializations.latestResultText
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.content} else ${runOutputMaterializations.latestResultText} end`,
            latestOutputSequence:
              latestOutput === null
                ? runOutputMaterializations.latestOutputSequence
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.sequenceNumber} else ${runOutputMaterializations.latestOutputSequence} end`,
            latestOutputText:
              latestOutput === null
                ? runOutputMaterializations.latestOutputText
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.content} else ${runOutputMaterializations.latestOutputText} end`,
            updatedAt,
          },
        });
    }
    signal.throwIfAborted();

    if (!thread) {
      return null;
    }

    const acknowledgedAt = nowDate();
    const firstAssistantClaimWhere = and(
      eq(agentRuns.id, payload.runId),
      isNotNull(agentRuns.apiStartedAt),
      isNull(agentRuns.firstAssistantEventAcknowledgedAt),
    );
    if (!firstAssistantClaimWhere) {
      throw new Error("First assistant acknowledgement predicate is empty");
    }
    const [firstAssistantClaim] =
      insertedRowCount > 0 && shouldAttemptFirstAssistantEventClaim
        ? await writeRunMetadataInTransaction(tx, {
            patch: { firstAssistantEventAcknowledgedAt: acknowledgedAt },
            where: firstAssistantClaimWhere,
          })
        : [];
    signal.throwIfAborted();

    return {
      thread,
      insertedRowCount,
      firstAssistantAcknowledgement:
        firstAssistantClaim?.apiStartedAt === null ||
        firstAssistantClaim?.apiStartedAt === undefined
          ? null
          : {
              apiStartedAt: firstAssistantClaim.apiStartedAt.getTime(),
              acknowledgedAt: acknowledgedAt.getTime(),
            },
    };
  });
}

export const materializeRunOutputEvents$ = command(
  async (
    { set },
    payload: EventConsumerPayload,
    signal: AbortSignal,
  ): Promise<MaterializedChatProjection | null> => {
    return await materializeRunOutputEvents(set(writeDb$), payload, signal);
  },
);

export async function publishMaterializedChatProjection(
  payload: EventConsumerPayload,
  projection: MaterializedChatProjection,
  signal: AbortSignal,
): Promise<void> {
  if (projection.insertedRowCount === 0) {
    return;
  }
  if (projection.firstAssistantAcknowledgement) {
    await publishFirstAssistantEventCreatedSignalSafely({
      userId: projection.thread.userId,
      orgId: projection.thread.orgId,
      threadId: projection.thread.chatThreadId,
    });
    recordFirstAssistantEventAcknowledgementMetric({
      runId: payload.runId,
      ...projection.firstAssistantAcknowledgement,
    });
  } else {
    await publishChatThreadMessageCreatedSafely({
      userId: projection.thread.userId,
      orgId: projection.thread.orgId,
      threadId: projection.thread.chatThreadId,
    });
  }
  signal.throwIfAborted();
}
