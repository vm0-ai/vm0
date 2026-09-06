import { command } from "ccstate";
import {
  compatibleStoredExecutionContextSchema,
  piApiFirstTurnManifestSchema,
} from "@okouai/api-contracts/contracts/runners";
import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { webhookEventsContract } from "@okouai/api-contracts/contracts/webhooks";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { runOutputLegacyPiEvents } from "@okouai/db/schema/run-output-legacy-pi-event";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { runOutputMemoryCitations } from "@okouai/db/schema/run-output-memory-citation";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
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
import { lockChatQueueThread } from "./chat-event-queue.service";
import {
  normalizeRunOutputEvents,
  type EventCitation,
} from "./pi-memory-citation-events";
import { piApiFirstTurnObjectKey } from "./pi-api-first-turn-config";

const RUN_OUTPUT_PROJECTION_LOCK_TIMEOUT = "1s";
const RUN_OUTPUT_PROJECTION_STATEMENT_TIMEOUT = "5s";
const LEGACY_PI_PENDING_EVENT_LIMIT = 512;
const LEGACY_PI_PENDING_BYTE_LIMIT = 16 * 1024 * 1024;
const PI_API_FIRST_TURN_MANIFEST_MAX_BYTES = 64 * 1024;
interface OutputCandidate {
  readonly sequenceNumber: number;
  readonly content: string;
}

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

export type RunOutputMaterializationResult =
  | {
      readonly outcome: "accepted";
      readonly chatProjection: MaterializedChatProjection | null;
      readonly payload: EventConsumerPayload;
    }
  | { readonly outcome: "ignored-timeout" };

interface RunOutputEventAdmission {
  readonly payload: EventConsumerPayload;
  readonly suppliedCitations: readonly EventCitation[];
  readonly currentPiTransport: boolean;
}

interface LegacyPiStagedRow {
  readonly sequenceNumber: number;
  readonly serializedEvent: string;
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

function assistantMessageIdForBuffer(event: AgentEvent): string | null {
  const message = recordOf(event.message);
  return typeof message?.id === "string" ? message.id : null;
}

function classifiedLegacyPiPrefixLength(
  events: readonly AgentEvent[],
  finalize: boolean,
): number {
  if (finalize || events.at(-1)?.type !== "assistant") {
    return events.length;
  }
  const trailingId = assistantMessageIdForBuffer(events.at(-1)!);
  let index = events.length - 1;
  while (
    index > 0 &&
    events[index - 1]?.type === "assistant" &&
    assistantMessageIdForBuffer(events[index - 1]!) === trailingId
  ) {
    index -= 1;
  }
  return index;
}

function serializeLegacyPiEvent(event: AgentEvent): string {
  const serialized = JSON.stringify(event);
  if (serialized === undefined) {
    throw new Error("Legacy Pi event must be JSON serializable");
  }
  return serialized;
}

function parseLegacyPiEvent(runId: string, serialized: string): AgentEvent {
  const value: unknown = JSON.parse(serialized);
  const parsed = webhookEventsContract.send.body.parse({
    runId,
    events: [value],
  });
  return parsed.events[0]!;
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

function assistantEventItems(args: {
  readonly events: readonly AgentEvent[];
}): InsertAssistantEventsInput["items"] {
  const items: InsertAssistantEventsInput["items"][number][] = [];
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
  }
  return items;
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
  const assistantItems = assistantEventItems({
    events: payload.events,
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
): Promise<RunStatus> {
  const [run] = await tx
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    throw new AgentEventRunNotFoundError(runId);
  }
  return runStatusSchema.parse(run.status);
}

type OutputMaterializationTransactionResult =
  | RunOutputMaterializationResult
  | { readonly outcome: "retry" };

async function insertMemoryCitations(
  tx: Tx,
  runId: string,
  citations: readonly EventCitation[],
): Promise<void> {
  if (citations.length === 0) {
    return;
  }
  await tx
    .insert(runOutputMemoryCitations)
    .values(
      citations.map((item) => {
        return {
          runId,
          sequenceNumber: item.sequenceNumber,
          citation: item.citation,
        };
      }),
    )
    .onConflictDoNothing();
}

function preparedRunOutputProjection(
  payload: EventConsumerPayload,
  parseHiddenText: boolean,
  suppliedCitations: readonly EventCitation[],
): {
  readonly payload: EventConsumerPayload;
  readonly citations: readonly EventCitation[];
  readonly latestResult: OutputCandidate | null;
  readonly latestOutput: OutputCandidate | null;
} {
  const normalized = normalizeRunOutputEvents(
    payload,
    parseHiddenText,
    suppliedCitations,
  );
  return {
    ...normalized,
    latestResult: latestCandidate(normalized.payload.events, resultText),
    latestOutput: latestCandidate(
      normalized.payload.events,
      callbackOutputText,
    ),
  };
}

const legacyPiSequenceStart$ = command(
  async ({ get, set }, runId: string, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const [state] = await db
      .select({
        processedThroughSequence:
          runOutputMaterializations.processedThroughSequence,
      })
      .from(runOutputMaterializations)
      .where(eq(runOutputMaterializations.runId, runId))
      .limit(1);
    signal.throwIfAborted();
    // Once the old-Guest cursor has initialized at zero or above, its exact
    // origin no longer affects contiguous admission.
    if ((state?.processedThroughSequence ?? -1) >= 0) {
      return 0;
    }
    const [job] = await db
      .select({
        executionContext: runnerJobQueue.executionContext,
      })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, runId))
      .limit(1);
    signal.throwIfAborted();
    const queuedContext = job
      ? compatibleStoredExecutionContextSchema.parse(job.executionContext)
      : undefined;
    const queuedSequenceStart =
      queuedContext?.piLaunchConfig?.apiFirstTurn?.sandboxEventSequenceStart;
    if (queuedSequenceStart !== undefined) {
      return queuedSequenceStart;
    }
    const [run] = await db
      .select({ launchSnapshot: agentRuns.launchSnapshot })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    if (
      run?.launchSnapshot?.framework !== "pi" ||
      run.launchSnapshot.schemaVersion !== 3
    ) {
      // Pre-API-first Pi runs began their Guest sequence at zero.
      return 0;
    }
    const manifestBytes = await get(
      downloadS3BufferWithMaxBytes(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        piApiFirstTurnObjectKey(runId, "manifest"),
        PI_API_FIRST_TURN_MANIFEST_MAX_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    return piApiFirstTurnManifestSchema.parse(manifest)
      .sandboxEventSequenceStart;
  },
);

async function legacyPiSequenceStart(
  resolve: () => Promise<number>,
  signal: AbortSignal,
): Promise<number> {
  const sequenceStart = await resolve();
  signal.throwIfAborted();
  return sequenceStart;
}

export class LegacyPiEventSequenceGapError extends Error {
  constructor(runId: string, expectedSequence: number) {
    super(
      `Run ${runId} is missing legacy Pi event sequence ${expectedSequence}`,
    );
    this.name = "LegacyPiEventSequenceGapError";
  }
}

function legacyPiStagedValues(
  payload: EventConsumerPayload,
  processedThroughSequence: number,
) {
  const stagedBySequence = new Map<number, AgentEvent>();
  for (const event of payload.events) {
    if (
      event.sequenceNumber > processedThroughSequence &&
      !stagedBySequence.has(event.sequenceNumber)
    ) {
      stagedBySequence.set(event.sequenceNumber, event);
    }
  }
  return [...stagedBySequence.values()].map((event) => {
    return {
      runId: payload.runId,
      sequenceNumber: event.sequenceNumber,
      serializedEvent: serializeLegacyPiEvent(event),
    };
  });
}

async function stageAndReadLegacyPiEvents(
  tx: Tx,
  payload: EventConsumerPayload,
  processedThroughSequence: number,
): Promise<readonly LegacyPiStagedRow[]> {
  const stagedValues = legacyPiStagedValues(payload, processedThroughSequence);
  if (stagedValues.length > 0) {
    await tx
      .insert(runOutputLegacyPiEvents)
      .values(stagedValues)
      .onConflictDoNothing();
  }
  return await tx
    .select({
      sequenceNumber: runOutputLegacyPiEvents.sequenceNumber,
      serializedEvent: runOutputLegacyPiEvents.serializedEvent,
    })
    .from(runOutputLegacyPiEvents)
    .where(eq(runOutputLegacyPiEvents.runId, payload.runId))
    .orderBy(asc(runOutputLegacyPiEvents.sequenceNumber));
}

function contiguousLegacyPiRows(args: {
  readonly runId: string;
  readonly stagedRows: readonly LegacyPiStagedRow[];
  readonly processedThroughSequence: number;
  readonly finalizeThrough?: number;
}): readonly LegacyPiStagedRow[] {
  const { runId, stagedRows, processedThroughSequence, finalizeThrough } = args;
  const sequenceBeyondCompletion =
    finalizeThrough === undefined
      ? undefined
      : stagedRows.find((row) => {
          return row.sequenceNumber > finalizeThrough;
        });
  if (sequenceBeyondCompletion) {
    throw new Error(
      `Run ${runId} has legacy Pi event sequence ${sequenceBeyondCompletion.sequenceNumber} beyond completion sequence ${finalizeThrough}`,
    );
  }

  const contiguousRows: LegacyPiStagedRow[] = [];
  let expectedSequence = processedThroughSequence + 1;
  for (const row of stagedRows) {
    if (row.sequenceNumber < expectedSequence) {
      continue;
    }
    if (row.sequenceNumber !== expectedSequence) {
      break;
    }
    contiguousRows.push(row);
    expectedSequence += 1;
  }
  if (
    finalizeThrough !== undefined &&
    processedThroughSequence < finalizeThrough &&
    expectedSequence <= finalizeThrough
  ) {
    throw new LegacyPiEventSequenceGapError(runId, expectedSequence);
  }
  return contiguousRows;
}

async function deleteReleasedLegacyPiRows(
  tx: Tx,
  runId: string,
  readyRows: readonly LegacyPiStagedRow[],
): Promise<void> {
  if (readyRows.length === 0) {
    return;
  }
  await tx.delete(runOutputLegacyPiEvents).where(
    and(
      eq(runOutputLegacyPiEvents.runId, runId),
      inArray(
        runOutputLegacyPiEvents.sequenceNumber,
        readyRows.map((row) => {
          return row.sequenceNumber;
        }),
      ),
    ),
  );
}

function boundedPendingLegacyPiRows(
  stagedRows: readonly LegacyPiStagedRow[],
  readyRows: readonly LegacyPiStagedRow[],
): readonly LegacyPiStagedRow[] {
  const readySequences = new Set(
    readyRows.map((row) => {
      return row.sequenceNumber;
    }),
  );
  const pendingRows = stagedRows.filter((row) => {
    return !readySequences.has(row.sequenceNumber);
  });
  const pendingBytes = pendingRows.reduce((total, row) => {
    return total + new TextEncoder().encode(row.serializedEvent).byteLength;
  }, 0);
  if (
    pendingRows.length > LEGACY_PI_PENDING_EVENT_LIMIT ||
    pendingBytes > LEGACY_PI_PENDING_BYTE_LIMIT
  ) {
    throw new Error("Legacy Pi event buffer exceeded its private bound");
  }
  return pendingRows;
}

async function materializeLegacyPiEventsInTransaction(
  args: {
    readonly tx: Tx;
    readonly payload: EventConsumerPayload;
    readonly thread: MaterializedChatProjection["thread"] | null;
    readonly sequenceStart: number;
    readonly finalizeThrough?: number;
  },
  signal: AbortSignal,
): Promise<RunOutputMaterializationResult> {
  const { tx, payload, thread, sequenceStart, finalizeThrough } = args;
  const initialProcessedSequence = sequenceStart - 1;
  await tx
    .insert(runOutputMaterializations)
    .values({
      runId: payload.runId,
      processedThroughSequence: initialProcessedSequence,
    })
    .onConflictDoNothing();
  const [lockedState] = await tx
    .select({
      processedThroughSequence:
        runOutputMaterializations.processedThroughSequence,
    })
    .from(runOutputMaterializations)
    .where(eq(runOutputMaterializations.runId, payload.runId))
    .for("update")
    .limit(1);
  if (!lockedState) {
    throw new Error("Legacy Pi output projection state was not initialized");
  }
  const processedThroughSequence = Math.max(
    lockedState.processedThroughSequence,
    initialProcessedSequence,
  );
  const stagedRows = await stageAndReadLegacyPiEvents(
    tx,
    payload,
    processedThroughSequence,
  );
  signal.throwIfAborted();
  const contiguousRows = contiguousLegacyPiRows({
    runId: payload.runId,
    stagedRows,
    processedThroughSequence,
    ...(finalizeThrough === undefined ? {} : { finalizeThrough }),
  });
  const contiguousEvents = contiguousRows.map((row) => {
    return parseLegacyPiEvent(payload.runId, row.serializedEvent);
  });
  const readyCount = classifiedLegacyPiPrefixLength(
    contiguousEvents,
    finalizeThrough !== undefined,
  );
  const readyRows = contiguousRows.slice(0, readyCount);
  const readyEvents = contiguousEvents.slice(0, readyCount);
  await deleteReleasedLegacyPiRows(tx, payload.runId, readyRows);
  const pendingRows = boundedPendingLegacyPiRows(stagedRows, readyRows);
  const nextProcessedSequence =
    readyRows.at(-1)?.sequenceNumber ?? processedThroughSequence;
  await tx
    .update(runOutputMaterializations)
    .set({
      processedThroughSequence: nextProcessedSequence,
      pendingSequenceNumbers: pendingRows.map((row) => {
        return row.sequenceNumber;
      }),
      updatedAt: nowDate(),
    })
    .where(eq(runOutputMaterializations.runId, payload.runId));

  const readyPayload: EventConsumerPayload = {
    ...payload,
    events: readyEvents,
  };
  if (readyEvents.length === 0) {
    return { outcome: "accepted", chatProjection: null, payload: readyPayload };
  }
  const prepared = preparedRunOutputProjection(readyPayload, true, []);
  return await materializeAdmittedRunOutputEvents(
    {
      tx,
      payload: prepared.payload,
      thread,
      latestResult: prepared.latestResult,
      latestOutput: prepared.latestOutput,
      citations: prepared.citations,
    },
    signal,
  );
}

async function materializeAdmittedRunOutputEvents(
  args: {
    readonly tx: Tx;
    readonly payload: EventConsumerPayload;
    readonly thread: MaterializedChatProjection["thread"] | null;
    readonly latestResult: OutputCandidate | null;
    readonly latestOutput: OutputCandidate | null;
    readonly citations: readonly EventCitation[];
  },
  signal: AbortSignal,
): Promise<RunOutputMaterializationResult> {
  const { tx, payload, thread, latestResult, latestOutput, citations } = args;
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
  await insertMemoryCitations(tx, payload.runId, citations);
  signal.throwIfAborted();

  if (!thread) {
    return { outcome: "accepted", chatProjection: null, payload };
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
    outcome: "accepted",
    payload,
    chatProjection: {
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
    },
  };
}

async function materializeRunOutputEvents(
  writeDb: Db,
  admission: RunOutputEventAdmission,
  resolveLegacySequenceStart: () => Promise<number>,
  signal: AbortSignal,
): Promise<RunOutputMaterializationResult> {
  const { payload, suppliedCitations, currentPiTransport } = admission;
  const [runProjection] = await writeDb
    .select({ launchSnapshot: agentRuns.launchSnapshot })
    .from(agentRuns)
    .where(eq(agentRuns.id, payload.runId))
    .limit(1);
  signal.throwIfAborted();
  if (!runProjection) {
    throw new AgentEventRunNotFoundError(payload.runId);
  }
  const legacyPiTransport =
    runProjection.launchSnapshot?.framework === "pi" && !currentPiTransport;
  const sequenceStart = legacyPiTransport
    ? await legacyPiSequenceStart(resolveLegacySequenceStart, signal)
    : 0;
  const prepared = legacyPiTransport
    ? null
    : preparedRunOutputProjection(payload, false, suppliedCitations);

  let expectedThread = await chatThreadForRunFromDb(writeDb, payload.runId);
  signal.throwIfAborted();
  while (true) {
    const result: OutputMaterializationTransactionResult =
      await writeDb.transaction(async (tx) => {
        await lockRunOutputProjection(tx, payload.runId, signal);
        const threadLocked = expectedThread
          ? await lockChatQueueThread(tx, expectedThread.chatThreadId)
          : false;
        signal.throwIfAborted();
        const status = await lockAgentRunForOutputMaterialization(
          tx,
          payload.runId,
          signal,
        );
        const thread = await chatThreadForRunFromDb(tx, payload.runId);
        signal.throwIfAborted();
        if (thread?.chatThreadId !== expectedThread?.chatThreadId) {
          return { outcome: "retry" };
        }
        if (expectedThread && !threadLocked) {
          throw new Error("Agent run retained a missing chat thread");
        }
        if (status === "timeout") {
          return { outcome: "ignored-timeout" };
        }

        if (legacyPiTransport) {
          // A promoted API can receive raw citation markup from an
          // already-running Pi Guest. Keep each not-yet-classifiable assistant
          // group in the private staging table until a later event establishes
          // its boundary. Remove this bridge only after the Runner/Sandbox
          // drain and retained rollback-artifact gates tracked by #31964 pass.
          return await materializeLegacyPiEventsInTransaction(
            { tx, payload, thread, sequenceStart },
            signal,
          );
        }
        if (!prepared) {
          throw new Error("Current output projection was not prepared");
        }
        return await materializeAdmittedRunOutputEvents(
          {
            tx,
            payload: prepared.payload,
            thread,
            latestResult: prepared.latestResult,
            latestOutput: prepared.latestOutput,
            citations: prepared.citations,
          },
          signal,
        );
      });
    signal.throwIfAborted();
    if (result.outcome !== "retry") {
      return result;
    }
    expectedThread = await chatThreadForRunFromDb(writeDb, payload.runId);
    signal.throwIfAborted();
  }
}

export const materializeRunOutputEvents$ = command(
  async (
    { set },
    admission: RunOutputEventAdmission,
    signal: AbortSignal,
  ): Promise<RunOutputMaterializationResult> => {
    return await materializeRunOutputEvents(
      set(writeDb$),
      admission,
      async () => {
        return await set(
          legacyPiSequenceStart$,
          admission.payload.runId,
          signal,
        );
      },
      signal,
    );
  },
);

async function legacyPiFinalizationRequired(
  writeDb: Db,
  runId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [run] = await writeDb
    .select({ launchSnapshot: agentRuns.launchSnapshot })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    throw new AgentEventRunNotFoundError(runId);
  }
  if (run.launchSnapshot?.framework !== "pi") {
    return false;
  }
  const [state] = await writeDb
    .select({
      processedThroughSequence:
        runOutputMaterializations.processedThroughSequence,
    })
    .from(runOutputMaterializations)
    .where(eq(runOutputMaterializations.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  if ((state?.processedThroughSequence ?? -1) >= 0) {
    return true;
  }
  const [staged] = await writeDb
    .select({ sequenceNumber: runOutputLegacyPiEvents.sequenceNumber })
    .from(runOutputLegacyPiEvents)
    .where(eq(runOutputLegacyPiEvents.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return staged !== undefined;
}

export const finalizeLegacyPiRunOutput$ = command(
  async (
    { set },
    input: {
      readonly runId: string;
      readonly context: EventConsumerPayload["context"];
      readonly lastEventSequence: number;
    },
    signal: AbortSignal,
  ): Promise<RunOutputMaterializationResult | null> => {
    const writeDb = set(writeDb$);
    if (!(await legacyPiFinalizationRequired(writeDb, input.runId, signal))) {
      return null;
    }
    const sequenceStart = await legacyPiSequenceStart(async () => {
      return await set(legacyPiSequenceStart$, input.runId, signal);
    }, signal);
    let expectedThread = await chatThreadForRunFromDb(writeDb, input.runId);
    signal.throwIfAborted();
    while (true) {
      const result:
        | OutputMaterializationTransactionResult
        | { readonly outcome: "not-legacy" } = await writeDb.transaction(
        async (tx) => {
          await lockRunOutputProjection(tx, input.runId, signal);
          const threadLocked = expectedThread
            ? await lockChatQueueThread(tx, expectedThread.chatThreadId)
            : false;
          signal.throwIfAborted();
          const status = await lockAgentRunForOutputMaterialization(
            tx,
            input.runId,
            signal,
          );
          const thread = await chatThreadForRunFromDb(tx, input.runId);
          signal.throwIfAborted();
          if (thread?.chatThreadId !== expectedThread?.chatThreadId) {
            return { outcome: "retry" };
          }
          if (expectedThread && !threadLocked) {
            throw new Error("Agent run retained a missing chat thread");
          }
          if (status === "timeout") {
            return { outcome: "ignored-timeout" };
          }
          const [state] = await tx
            .select({
              processedThroughSequence:
                runOutputMaterializations.processedThroughSequence,
            })
            .from(runOutputMaterializations)
            .where(eq(runOutputMaterializations.runId, input.runId))
            .limit(1);
          const [staged] = await tx
            .select({ sequenceNumber: runOutputLegacyPiEvents.sequenceNumber })
            .from(runOutputLegacyPiEvents)
            .where(eq(runOutputLegacyPiEvents.runId, input.runId))
            .limit(1);
          const legacyTransportActive =
            staged !== undefined ||
            (state?.processedThroughSequence ?? -1) >= sequenceStart;
          if (!legacyTransportActive) {
            return { outcome: "not-legacy" };
          }
          return await materializeLegacyPiEventsInTransaction(
            {
              tx,
              payload: {
                runId: input.runId,
                events: [],
                context: input.context,
              },
              thread,
              sequenceStart,
              finalizeThrough: input.lastEventSequence,
            },
            signal,
          );
        },
      );
      signal.throwIfAborted();
      if (result.outcome === "retry") {
        expectedThread = await chatThreadForRunFromDb(writeDb, input.runId);
        signal.throwIfAborted();
        continue;
      }
      if (result.outcome === "not-legacy") {
        return null;
      }
      return result;
    }
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
