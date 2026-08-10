import { randomUUID } from "node:crypto";

import {
  runStatusSchema,
  type RunStatus,
} from "@vm0/api-contracts/contracts/runs";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@vm0/db/schema/active-input-delivery";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import {
  activeInputDeliveryPromptFitsControlPayload,
  activeInputRowsByIds,
  materializePendingActiveInputPrompts,
  pendingActiveInputRows,
  type PendingActiveInputRow,
} from "./active-input-prompt.service";
import { lockChatQueueThread } from "./chat-event-queue.service";
import { replaceLoadedChatEvent } from "./zero-chat-event.service";

interface ActiveInputDeliveryScope {
  readonly runId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly status: RunStatus;
}

interface ActiveInputDeliveryReference {
  readonly deliveryId: string;
  readonly eventIds: readonly string[];
}

type ReserveActiveInputDeliveryResult =
  | ({
      readonly outcome: "reserved";
      readonly prompt: string;
    } & ActiveInputDeliveryReference)
  | { readonly outcome: "empty" }
  | { readonly outcome: "terminal" }
  | ({ readonly outcome: "held" } & ActiveInputDeliveryReference)
  | {
      readonly outcome: "rejected";
      readonly reason: "payload_too_large" | "run_not_running";
    }
  | { readonly outcome: "forbidden" };

type RecordActiveInputDeliveryReceiptResult =
  | {
      readonly outcome: "delivered";
      readonly replacementsAppended: boolean;
      readonly chatThreadId: string;
    }
  | { readonly outcome: "rejected"; readonly replacementsAppended: false }
  | { readonly outcome: "forbidden"; readonly replacementsAppended: false };

type ActiveInputDeliveryTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

type PreparedReservation =
  | { readonly kind: "empty" }
  | { readonly kind: "rejected"; readonly reason: "payload_too_large" }
  | {
      readonly kind: "ready";
      readonly deliveryId: string;
      readonly eventIds: readonly string[];
      readonly prompt: string;
    };

type ReserveTransitionResult =
  | Exclude<ReserveActiveInputDeliveryResult, { readonly outcome: "reserved" }>
  | ({
      readonly outcome: "created";
      readonly prompt: string;
    } & ActiveInputDeliveryReference)
  | ({ readonly outcome: "retrieve" } & ActiveInputDeliveryReference)
  | { readonly outcome: "retry" };

const deliveryRevoker = alias(chatEvents, "active_input_delivery_revoker");

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

async function loadActiveInputDeliveryScope(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<ActiveInputDeliveryScope | null> {
  const [row] = await db
    .select({
      runId: agentRuns.id,
      chatThreadId: zeroRuns.chatThreadId,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row?.chatThreadId) {
    return null;
  }
  return {
    ...row,
    chatThreadId: row.chatThreadId,
    status: runStatusSchema.parse(row.status),
  };
}

function combinedPrompt(
  rows: readonly PendingActiveInputRow[],
  prompts: ReadonlyMap<string, string>,
): string {
  return rows
    .map((row) => {
      const prompt = prompts.get(row.id);
      if (prompt === undefined) {
        throw new Error("Active input prompt materialization is missing");
      }
      return prompt;
    })
    .join("\n\n");
}

async function prepareReservation(
  db: Db,
  scope: ActiveInputDeliveryScope,
  signal: AbortSignal,
): Promise<PreparedReservation> {
  const rows = await pendingActiveInputRows(
    db,
    scope.chatThreadId,
    scope.runId,
  );
  signal.throwIfAborted();
  if (rows.length === 0) {
    return { kind: "empty" };
  }
  const prompts = await materializePendingActiveInputPrompts(
    db,
    rows,
    scope,
    signal,
  );
  if (!prompts) {
    throw new Error("Pending active input cannot be materialized");
  }
  const prompt = combinedPrompt(rows, prompts);
  const deliveryId = randomUUID();
  if (!activeInputDeliveryPromptFitsControlPayload(deliveryId, prompt)) {
    return { kind: "rejected", reason: "payload_too_large" };
  }
  return {
    kind: "ready",
    deliveryId,
    eventIds: rows.map((row) => {
      return row.id;
    }),
    prompt,
  };
}

async function lockOpenDelivery(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryScope,
): Promise<ActiveInputDeliveryReference | null> {
  const [delivery] = await tx
    .select({
      id: activeInputDeliveries.id,
      chatThreadId: activeInputDeliveries.chatThreadId,
    })
    .from(activeInputDeliveries)
    .where(
      and(
        eq(activeInputDeliveries.runId, scope.runId),
        eq(activeInputDeliveries.status, "open"),
      ),
    )
    .for("update")
    .limit(1);
  if (!delivery) {
    return null;
  }
  if (delivery.chatThreadId !== scope.chatThreadId) {
    throw new Error("Active input delivery belongs to an unexpected thread");
  }
  const items = await tx
    .select({
      sourceEventId: activeInputDeliveryItems.sourceEventId,
      disposition: activeInputDeliveryItems.disposition,
    })
    .from(activeInputDeliveryItems)
    .where(eq(activeInputDeliveryItems.deliveryId, delivery.id))
    .orderBy(asc(activeInputDeliveryItems.position))
    .for("update");
  if (
    items.length === 0 ||
    items.some((item) => {
      return item.disposition !== null;
    })
  ) {
    throw new Error("Open active input delivery has invalid items");
  }
  return {
    deliveryId: delivery.id,
    eventIds: items.map((item) => {
      return item.sourceEventId;
    }),
  };
}

async function transitionReservation(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryScope,
  prepared: PreparedReservation,
): Promise<ReserveTransitionResult> {
  if (!(await lockChatQueueThread(tx, scope.chatThreadId))) {
    return { outcome: "forbidden" };
  }
  const [run] = await tx
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, scope.runId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.orgId, scope.orgId),
      ),
    )
    .for("update")
    .limit(1);
  if (!run) {
    return { outcome: "forbidden" };
  }
  const status = runStatusSchema.parse(run.status);
  const openDelivery = await lockOpenDelivery(tx, scope);
  if (openDelivery) {
    return status === "running"
      ? { outcome: "retrieve", ...openDelivery }
      : { outcome: "held", ...openDelivery };
  }
  if (isTerminalRunStatus(status)) {
    return { outcome: "terminal" };
  }
  if (status !== "running") {
    return { outcome: "rejected", reason: "run_not_running" };
  }
  if (prepared.kind === "empty") {
    return { outcome: "empty" };
  }
  if (prepared.kind === "rejected") {
    return { outcome: "rejected", reason: prepared.reason };
  }
  const currentRows = await pendingActiveInputRows(
    tx,
    scope.chatThreadId,
    scope.runId,
    prepared.eventIds,
  );
  if (
    currentRows.length !== prepared.eventIds.length ||
    currentRows.some((row, index) => {
      return row.id !== prepared.eventIds[index];
    })
  ) {
    return { outcome: "retry" };
  }
  await tx.insert(activeInputDeliveries).values({
    id: prepared.deliveryId,
    runId: scope.runId,
    chatThreadId: scope.chatThreadId,
    status: "open",
  });
  await tx.insert(activeInputDeliveryItems).values(
    prepared.eventIds.map((sourceEventId, position) => {
      return {
        deliveryId: prepared.deliveryId,
        sourceEventId,
        position,
      };
    }),
  );
  return {
    outcome: "created",
    deliveryId: prepared.deliveryId,
    eventIds: prepared.eventIds,
    prompt: prepared.prompt,
  };
}

async function materializeDelivery(
  db: Db,
  scope: ActiveInputDeliveryScope,
  delivery: ActiveInputDeliveryReference,
  signal: AbortSignal,
): Promise<string> {
  const rows = await activeInputRowsByIds(
    db,
    scope.chatThreadId,
    delivery.eventIds,
  );
  signal.throwIfAborted();
  if (
    rows.length !== delivery.eventIds.length ||
    rows.some((row, index) => {
      return row.id !== delivery.eventIds[index];
    })
  ) {
    throw new Error("Active input delivery source membership is invalid");
  }
  const prompts = await materializePendingActiveInputPrompts(
    db,
    rows,
    scope,
    signal,
  );
  if (!prompts) {
    throw new Error("Active input delivery cannot be rematerialized");
  }
  const prompt = combinedPrompt(rows, prompts);
  if (
    !activeInputDeliveryPromptFitsControlPayload(delivery.deliveryId, prompt)
  ) {
    throw new Error("Active input delivery exceeds the control payload limit");
  }
  return prompt;
}

export async function reserveActiveInputDelivery(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<ReserveActiveInputDeliveryResult> {
  const scope = await loadActiveInputDeliveryScope(db, args, signal);
  if (!scope) {
    return { outcome: "forbidden" };
  }
  while (true) {
    const prepared =
      scope.status === "running"
        ? await prepareReservation(db, scope, signal)
        : ({ kind: "empty" } as const);
    const result = await db.transaction(async (tx) => {
      return await transitionReservation(tx, scope, prepared);
    });
    signal.throwIfAborted();
    if (result.outcome === "retry") {
      continue;
    }
    if (result.outcome === "created") {
      return {
        outcome: "reserved",
        deliveryId: result.deliveryId,
        eventIds: result.eventIds,
        prompt: result.prompt,
      };
    }
    if (result.outcome === "retrieve") {
      return {
        outcome: "reserved",
        deliveryId: result.deliveryId,
        eventIds: result.eventIds,
        prompt: await materializeDelivery(db, scope, result, signal),
      };
    }
    return result;
  }
}

export async function replacePendingActiveInputEvent(
  tx: ActiveInputDeliveryTransaction,
  event: PendingActiveInputRow,
  runId: string,
): Promise<void> {
  if (!event.userMessage) {
    throw new Error("Pending active input has invalid prompt data");
  }
  if (
    event.eventType !== "input.prompt" &&
    event.eventType !== "input.budget"
  ) {
    throw new Error("Pending active input has invalid event type");
  }
  const target = {
    id: event.id,
    chatThreadId: event.chatThreadId,
    createdAt: event.createdAt,
    eventType: event.eventType,
    contextType: event.contextType,
    contextId: event.contextId,
  };
  const replacement =
    event.eventType === "input.budget"
      ? await replaceLoadedChatEvent(tx, target, {
          chatThreadId: event.chatThreadId,
          eventType: "input.budget",
          runId,
          userMessage: event.userMessage,
        })
      : await replaceLoadedChatEvent(tx, target, {
          chatThreadId: event.chatThreadId,
          eventType: "input.prompt",
          runId,
          userMessage: event.userMessage,
        });
  if (!replacement) {
    throw new Error("Active input replacement lost after locking the thread");
  }
}

function sourceIsPendingForRun(
  source: Awaited<ReturnType<typeof activeInputRowsByIds>>[number],
  runId: string,
): boolean {
  if (source.runId !== null) {
    return false;
  }
  if (source.eventType === "input.prompt") {
    return source.contextType !== "morning_brief";
  }
  return (
    source.eventType === "input.budget" &&
    source.contextType === "agent_run" &&
    source.contextId === runId
  );
}

interface LockedActiveInputDeliveryReceipt {
  readonly status: (typeof activeInputDeliveries.$inferSelect)["status"];
  readonly items: readonly {
    readonly sourceEventId: string;
    readonly disposition: (typeof activeInputDeliveryItems.$inferSelect)["disposition"];
  }[];
}

async function lockActiveInputDeliveryReceipt(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryScope,
  deliveryId: string,
): Promise<LockedActiveInputDeliveryReceipt | null> {
  if (!(await lockChatQueueThread(tx, scope.chatThreadId))) {
    return null;
  }
  const [run] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, scope.runId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.orgId, scope.orgId),
      ),
    )
    .for("update")
    .limit(1);
  if (!run) {
    return null;
  }
  const [delivery] = await tx
    .select({ status: activeInputDeliveries.status })
    .from(activeInputDeliveries)
    .where(
      and(
        eq(activeInputDeliveries.id, deliveryId),
        eq(activeInputDeliveries.runId, scope.runId),
        eq(activeInputDeliveries.chatThreadId, scope.chatThreadId),
      ),
    )
    .for("update")
    .limit(1);
  if (!delivery) {
    return null;
  }
  const items = await tx
    .select({
      sourceEventId: activeInputDeliveryItems.sourceEventId,
      disposition: activeInputDeliveryItems.disposition,
    })
    .from(activeInputDeliveryItems)
    .where(eq(activeInputDeliveryItems.deliveryId, deliveryId))
    .orderBy(asc(activeInputDeliveryItems.position))
    .for("update");
  if (items.length === 0) {
    throw new Error("Active input delivery has no items");
  }
  return { status: delivery.status, items };
}

async function settleOpenActiveInputDeliveryReceipt(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryScope,
  deliveryId: string,
  items: LockedActiveInputDeliveryReceipt["items"],
): Promise<RecordActiveInputDeliveryReceiptResult> {
  const eventIds = items.map((item) => {
    return item.sourceEventId;
  });
  const sources = await activeInputRowsByIds(
    tx,
    scope.chatThreadId,
    eventIds,
  ).for("update");
  if (
    sources.length !== eventIds.length ||
    sources.some((source, index) => {
      return source.id !== eventIds[index];
    })
  ) {
    throw new Error("Active input delivery source membership is invalid");
  }
  const revokers = await tx
    .select({
      revokesEventId: deliveryRevoker.revokesEventId,
      eventType: deliveryRevoker.eventType,
      runId: deliveryRevoker.runId,
    })
    .from(deliveryRevoker)
    .where(inArray(deliveryRevoker.revokesEventId, eventIds))
    .for("update");
  const revokerBySource = new Map(
    revokers.map((revoker) => {
      if (!revoker.revokesEventId) {
        throw new Error("Active input revoker is missing its source event");
      }
      return [revoker.revokesEventId, revoker] as const;
    }),
  );
  const invalidSource = sources.some((source) => {
    const revoker = revokerBySource.get(source.id);
    if (revoker) {
      return !(
        revoker.runId === scope.runId &&
        revoker.eventType === source.eventType &&
        (source.eventType === "input.prompt" ||
          source.eventType === "input.budget")
      );
    }
    return !sourceIsPendingForRun(source, scope.runId);
  });
  if (invalidSource) {
    return { outcome: "rejected", replacementsAppended: false };
  }
  let replacementsAppended = false;
  for (const source of sources) {
    if (!revokerBySource.has(source.id)) {
      await replacePendingActiveInputEvent(tx, source, scope.runId);
      replacementsAppended = true;
    }
  }
  const updatedItems = await tx
    .update(activeInputDeliveryItems)
    .set({ disposition: "delivered" })
    .where(
      and(
        eq(activeInputDeliveryItems.deliveryId, deliveryId),
        isNull(activeInputDeliveryItems.disposition),
      ),
    )
    .returning({ sourceEventId: activeInputDeliveryItems.sourceEventId });
  if (updatedItems.length !== items.length) {
    throw new Error("Active input delivery item settlement was incomplete");
  }
  const [settled] = await tx
    .update(activeInputDeliveries)
    .set({ status: "settled" })
    .where(
      and(
        eq(activeInputDeliveries.id, deliveryId),
        eq(activeInputDeliveries.status, "open"),
      ),
    )
    .returning({ id: activeInputDeliveries.id });
  if (!settled) {
    throw new Error("Active input delivery settlement was incomplete");
  }
  return {
    outcome: "delivered",
    replacementsAppended,
    chatThreadId: scope.chatThreadId,
  };
}

async function recordActiveInputDeliveryReceiptTransition(
  tx: ActiveInputDeliveryTransaction,
  scope: ActiveInputDeliveryScope,
  deliveryId: string,
): Promise<RecordActiveInputDeliveryReceiptResult> {
  const delivery = await lockActiveInputDeliveryReceipt(tx, scope, deliveryId);
  if (!delivery) {
    return { outcome: "forbidden", replacementsAppended: false };
  }
  if (delivery.status === "settled") {
    if (
      delivery.items.every((item) => {
        return item.disposition === "delivered";
      })
    ) {
      return {
        outcome: "delivered",
        replacementsAppended: false,
        chatThreadId: scope.chatThreadId,
      };
    }
    if (
      delivery.items.every((item) => {
        return item.disposition !== null;
      })
    ) {
      return { outcome: "rejected", replacementsAppended: false };
    }
    throw new Error("Settled active input delivery has open items");
  }
  if (
    delivery.items.some((item) => {
      return item.disposition !== null;
    })
  ) {
    throw new Error("Open active input delivery has settled items");
  }
  return await settleOpenActiveInputDeliveryReceipt(
    tx,
    scope,
    deliveryId,
    delivery.items,
  );
}

export async function recordActiveInputDeliveryReceipt(
  db: Db,
  args: {
    readonly runId: string;
    readonly deliveryId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<RecordActiveInputDeliveryReceiptResult> {
  const scope = await loadActiveInputDeliveryScope(db, args, signal);
  if (!scope) {
    return { outcome: "forbidden", replacementsAppended: false };
  }
  const result = await db.transaction(async (tx) => {
    return await recordActiveInputDeliveryReceiptTransition(
      tx,
      scope,
      args.deliveryId,
    );
  });
  signal.throwIfAborted();
  return result;
}
