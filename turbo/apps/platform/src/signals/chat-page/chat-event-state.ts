import {
  chatEventCompatibilityRole,
  isBrowserLifecycleEventType,
  isChatRunTerminalEventType,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "@vm0/api-contracts/contracts/chat-events";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import type { ChatEvent } from "./chat-event-types.ts";

type RecallControlEvent = Extract<
  ChatEvent,
  { eventType: "control.revoke" | "run.dequeued" }
>;

export function isRecallControlEvent(
  event: ChatEvent,
): event is RecallControlEvent {
  return (
    event.eventType === "control.revoke" || event.eventType === "run.dequeued"
  );
}

export function isQueueMarkerEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "run.queued" }> {
  return event.eventType === "run.queued";
}

export function isGoalMarkerEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "goal.changed" }> {
  return event.eventType === "goal.changed";
}

export function isGoalQueueEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "input.goal" }> {
  return event.eventType === "input.goal";
}

export function isUsageEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "usage.recorded" }> {
  return event.eventType === "usage.recorded";
}

export function isInterruptControlEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "control.interrupt" }> {
  return event.eventType === "control.interrupt";
}

function createInterruptedAssistantProjection(
  event: Extract<ChatEvent, { eventType: "control.interrupt" }>,
  runId: string,
): ChatEvent {
  const { interruptsRunId, ...rest } = event;
  void interruptsRunId;
  return {
    ...rest,
    eventType: "run.cancelled" as const,
    content: "Run cancelled",
    runId,
    error: "Run cancelled",
    runLifecycleEvent: "cancelled",
  };
}

export function isInterruptedAssistantCancellation(
  event: ChatEvent,
  interruptedRunIds: ReadonlySet<string>,
): boolean {
  const runId = event.runId;
  return (
    runId !== undefined &&
    isCancelledRunEvent(event) &&
    interruptedRunIds.has(runId)
  );
}

export interface SemanticChatEventState {
  readonly event: ChatEvent;
  readonly isQueued: boolean;
  readonly isOptimisticRun: boolean;
}

type QueuedChatEvent = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.automation" }
>;

function isQueuedChatEvent(event: ChatEvent): event is QueuedChatEvent {
  return (
    event.eventType === "input.prompt" || event.eventType === "input.automation"
  );
}

export interface SemanticChatEventGroup<
  T extends SemanticChatEventState = SemanticChatEventState,
> {
  readonly role: "user" | "assistant";
  readonly events: T[];
}

export interface SemanticChatGroups<
  T extends SemanticChatEventState = SemanticChatEventState,
> {
  readonly activeGroups: SemanticChatEventGroup<T>[];
  readonly allGroups: SemanticChatEventGroup<T>[];
}

export function semanticChatEventsFromChatEvents(
  events: readonly ChatEvent[],
): SemanticChatEventState[] {
  const interruptedRunIds = new Set(
    events.flatMap((event) => {
      return isInterruptControlEvent(event) && event.interruptsRunId
        ? [event.interruptsRunId]
        : [];
    }),
  );
  const recalledIds = new Set(
    events.flatMap((event) => {
      return isRecallControlEvent(event) && event.revokesEventId
        ? [event.revokesEventId]
        : [];
    }),
  );
  const replacedIds = new Set(
    events.flatMap((event) => {
      return !isRecallControlEvent(event) && event.revokesEventId
        ? [event.revokesEventId]
        : [];
    }),
  );

  return events.flatMap((event): SemanticChatEventState[] => {
    if (
      isRecallControlEvent(event) ||
      isQueueMarkerEvent(event) ||
      isGoalQueueEvent(event) ||
      isGoalMarkerEvent(event) ||
      isBrowserLifecycleEventType(event.eventType) ||
      isInterruptedAssistantCancellation(event, interruptedRunIds) ||
      recalledIds.has(event.id) ||
      replacedIds.has(event.id)
    ) {
      return [];
    }
    if (isInterruptControlEvent(event) && event.interruptsRunId) {
      return [
        {
          event: createInterruptedAssistantProjection(
            event,
            event.interruptsRunId,
          ),
          isQueued: false,
          isOptimisticRun: false,
        },
      ];
    }

    const isUnassociatedUser =
      chatEventCompatibilityRole(event.eventType) === "user" &&
      event.runId === undefined;
    const optimisticAssociation = event.optimisticUserMessageAssociation;
    const isOptimisticRun =
      isUnassociatedUser && optimisticAssociation === "run";
    const isQueued =
      isUnassociatedUser &&
      optimisticAssociation !== "run" &&
      (event.eventType === "input.prompt" ||
        event.eventType === "input.automation");
    return [{ event, isQueued, isOptimisticRun }];
  });
}

function orderSemanticEventsByRunTurn<T extends SemanticChatEventState>(
  events: readonly T[],
): T[] {
  const items: { order: number; events: T[] }[] = [];
  const itemByRunId = new Map<string, (typeof items)[number]>();

  for (const semanticEvent of events) {
    const runId = semanticEvent.event.runId;
    if (runId === undefined) {
      items.push({ order: items.length, events: [semanticEvent] });
      continue;
    }
    const existing = itemByRunId.get(runId);
    if (existing) {
      existing.events.push(semanticEvent);
      continue;
    }
    const item = { order: items.length, events: [semanticEvent] };
    itemByRunId.set(runId, item);
    items.push(item);
  }

  return items
    .sort((left, right) => {
      return left.order - right.order;
    })
    .flatMap((item) => {
      return item.events;
    });
}

function shouldMergeSemanticEvent<T extends SemanticChatEventState>(
  group: SemanticChatEventGroup<T>,
  semanticEvent: T,
): boolean {
  if (
    group.role !== chatEventCompatibilityRole(semanticEvent.event.eventType)
  ) {
    return false;
  }
  if (group.role !== "assistant") {
    return true;
  }
  const groupRunId = group.events.find((entry) => {
    return entry.event.runId !== undefined;
  })?.event.runId;
  const eventRunId = semanticEvent.event.runId;
  return (
    groupRunId === undefined ||
    eventRunId === undefined ||
    groupRunId === eventRunId
  );
}

function groupSemanticEvents<T extends SemanticChatEventState>(
  events: readonly T[],
): SemanticChatEventGroup<T>[] {
  const groups: SemanticChatEventGroup<T>[] = [];
  for (const semanticEvent of events) {
    const lastGroup = groups.at(-1);
    if (lastGroup && shouldMergeSemanticEvent(lastGroup, semanticEvent)) {
      lastGroup.events.push(semanticEvent);
      continue;
    }
    groups.push({
      role: chatEventCompatibilityRole(semanticEvent.event.eventType),
      events: [semanticEvent],
    });
  }
  return groups;
}

export function groupSemanticChatEvents<T extends SemanticChatEventState>(
  semanticEvents: readonly T[],
): SemanticChatGroups<T> {
  const activeEvents: T[] = [];
  const queuedEvents: T[] = [];
  for (const semanticEvent of semanticEvents) {
    if (isUsageEvent(semanticEvent.event)) {
      continue;
    }
    if (
      chatEventCompatibilityRole(semanticEvent.event.eventType) === "user" &&
      semanticEvent.isQueued
    ) {
      queuedEvents.push(semanticEvent);
      continue;
    }
    activeEvents.push(semanticEvent);
  }
  const activeGroups = groupSemanticEvents(
    orderSemanticEventsByRunTurn(activeEvents),
  );
  return {
    activeGroups,
    allGroups: [...activeGroups, ...groupSemanticEvents(queuedEvents)],
  };
}

export function queuedEventsFromSemanticEvents(
  semanticEvents: readonly SemanticChatEventState[],
): QueuedChatEvent[] {
  return semanticEvents.flatMap((entry) => {
    const { event } = entry;
    return chatEventCompatibilityRole(event.eventType) === "user" &&
      entry.isQueued &&
      isQueuedChatEvent(event)
      ? [event]
      : [];
  });
}

export function queuedEventsFromChatEvents(
  events: readonly ChatEvent[],
): QueuedChatEvent[] {
  return queuedEventsFromSemanticEvents(
    semanticChatEventsFromChatEvents(events),
  );
}

export function lastAssistantCancelledFromGroups(
  groups: SemanticChatGroups,
): boolean {
  const lastGroup = groups.allGroups.at(-1);
  const lastEvent = lastGroup?.events.at(-1)?.event;
  return lastEvent ? isCancelledRunEvent(lastEvent) : false;
}

export type RunIndicatorState = "running" | "queued" | null;

function runActivityIndicatorState(
  terminatedRunIds: ReadonlySet<string>,
  runId: string,
): RunIndicatorState | undefined {
  if (terminatedRunIds.has(runId)) {
    return undefined;
  }
  return "running";
}

function assistantRunIndicatorState(
  terminatedRunIds: ReadonlySet<string>,
  event: ChatEvent,
): RunIndicatorState | undefined {
  const runId = event.runId;
  if (isQueueMarkerEvent(event)) {
    if (runId !== undefined && terminatedRunIds.has(runId)) {
      return undefined;
    }
    return "queued";
  }
  if (runId !== undefined && isChatRunTerminalEventType(event.eventType)) {
    return null;
  }
  if (runId === undefined) {
    return undefined;
  }
  return runActivityIndicatorState(terminatedRunIds, runId);
}

function nonAssistantRunIndicatorState(
  terminatedRunIds: ReadonlySet<string>,
  event: ChatEvent,
): RunIndicatorState | undefined {
  if (
    event.eventType === "input.prompt" &&
    event.runId === undefined &&
    event.optimisticUserMessageAssociation === "run"
  ) {
    return "running";
  }
  const { runId } = event;
  return runId === undefined
    ? undefined
    : runActivityIndicatorState(terminatedRunIds, runId);
}

function visibleRunStartIndexByRunId(
  events: readonly ChatEvent[],
  revokedEventIds: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const runStartIndexByRunId = new Map<string, number>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const runId = event.runId;
    if (
      (event.eventType !== "input.prompt" &&
        event.eventType !== "input.rejected") ||
      runId === undefined ||
      runStartIndexByRunId.has(runId) ||
      revokedEventIds.has(event.id)
    ) {
      continue;
    }
    runStartIndexByRunId.set(runId, index);
  }
  return runStartIndexByRunId;
}

function laterStartedRunIndicatorState(
  events: readonly ChatEvent[],
  terminatedRunId: string,
  terminatedRunIds: ReadonlySet<string>,
  revokedEventIds: ReadonlySet<string>,
  runStartIndexByRunId: ReadonlyMap<string, number>,
): RunIndicatorState | undefined {
  const terminatedRunStartIndex = runStartIndexByRunId.get(terminatedRunId);
  if (terminatedRunStartIndex === undefined) {
    return undefined;
  }

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const runId = event.runId;
    if (
      runId === undefined ||
      (runStartIndexByRunId.get(runId) ?? -1) <= terminatedRunStartIndex ||
      revokedEventIds.has(event.id) ||
      isUsageEvent(event) ||
      isGoalMarkerEvent(event)
    ) {
      continue;
    }
    const state =
      chatEventCompatibilityRole(event.eventType) === "assistant"
        ? assistantRunIndicatorState(terminatedRunIds, event)
        : nonAssistantRunIndicatorState(terminatedRunIds, event);
    if (state === "running" || state === "queued") {
      return state;
    }
  }
  return undefined;
}

export function deriveRunIndicatorStateFromChatEvents(
  events: readonly ChatEvent[],
): RunIndicatorState {
  const revokedEventIds = revokedChatEventIds(events);
  const terminatedRunIds = terminatedChatRunIds(events);
  const runStartIndexByRunId = visibleRunStartIndexByRunId(
    events,
    revokedEventIds,
  );

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (revokedEventIds.has(event.id)) {
      continue;
    }
    if (isUsageEvent(event) || isGoalMarkerEvent(event)) {
      continue;
    }
    if (chatEventCompatibilityRole(event.eventType) === "assistant") {
      const state = assistantRunIndicatorState(terminatedRunIds, event);
      if (state === null && event.runId !== undefined) {
        const laterRunState = laterStartedRunIndicatorState(
          events,
          event.runId,
          terminatedRunIds,
          revokedEventIds,
          runStartIndexByRunId,
        );
        if (laterRunState !== undefined) {
          return laterRunState;
        }
      }
      if (state !== undefined) {
        return state;
      }
      continue;
    }
    const state = nonAssistantRunIndicatorState(terminatedRunIds, event);
    if (state !== undefined) {
      return state;
    }
  }
  return null;
}

export function liveRunIdsFromChatEvents(
  events: readonly ChatEvent[],
): string[] {
  const terminatedRunIds = terminatedChatRunIds(events);
  const revokedEventIds = revokedChatEventIds(events);
  const liveRunIds: string[] = [];
  const seenRunIds = new Set<string>();
  for (const event of events) {
    const runId = event.runId;
    if (
      runId !== undefined &&
      !revokedEventIds.has(event.id) &&
      !terminatedRunIds.has(runId) &&
      !isQueueMarkerEvent(event) &&
      !isUsageEvent(event) &&
      !isGoalMarkerEvent(event) &&
      !seenRunIds.has(runId)
    ) {
      liveRunIds.push(runId);
      seenRunIds.add(runId);
    }
  }
  return liveRunIds;
}
