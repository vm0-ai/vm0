import {
  chatEventCompatibilityRole,
  foldChatRunStates,
  isBrowserLifecycleEventType,
  isChatGoalMarkerEventType,
  isChatInputEventType,
  isChatRunTerminalEventType,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "@okouai/api-contracts/contracts/chat-events";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
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
): event is Extract<ChatEvent, { eventType: "goal.open" | "goal.close" }> {
  return isChatGoalMarkerEventType(event.eventType);
}

export function isFollowupsEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "output.followups" }> {
  return event.eventType === "output.followups";
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
  readonly inputCreatedAt?: string;
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

function isHiddenSemanticChatEvent(
  event: ChatEvent,
  context: {
    readonly interruptedRunIds: ReadonlySet<string>;
    readonly automationInputIds: ReadonlySet<string>;
    readonly recalledIds: ReadonlySet<string>;
    readonly replacedIds: ReadonlySet<string>;
  },
): boolean {
  return (
    isRecallControlEvent(event) ||
    isQueueMarkerEvent(event) ||
    isGoalQueueEvent(event) ||
    event.eventType === "input.budget" ||
    isGoalMarkerEvent(event) ||
    isBrowserLifecycleEventType(event.eventType) ||
    isInterruptedAssistantCancellation(event, context.interruptedRunIds) ||
    (event.eventType === "input.rejected" &&
      event.revokesEventId !== undefined &&
      context.automationInputIds.has(event.revokesEventId)) ||
    context.recalledIds.has(event.id) ||
    context.replacedIds.has(event.id)
  );
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
  const automationInputIds = new Set(
    events.flatMap((event) => {
      return event.eventType === "input.automation" ? [event.id] : [];
    }),
  );

  // Resolve submission times before hiding replaced inputs. Delivery appends a
  // new event, but does not start another user-facing work interval.
  const inputCreatedAtById = new Map<string, string>();
  for (const event of events) {
    if (isChatInputEventType(event.eventType)) {
      const previousCreatedAt = event.revokesEventId
        ? inputCreatedAtById.get(event.revokesEventId)
        : undefined;
      inputCreatedAtById.set(event.id, previousCreatedAt ?? event.createdAt);
    }
  }

  return events.flatMap((event): SemanticChatEventState[] => {
    if (
      isHiddenSemanticChatEvent(event, {
        interruptedRunIds,
        automationInputIds,
        recalledIds,
        replacedIds,
      })
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
        },
      ];
    }

    const isUnassociatedUser =
      chatEventCompatibilityRole(event.eventType) === "user" &&
      event.runId === undefined;
    const optimisticAssociation = event.optimisticUserMessageAssociation;
    const isQueued =
      isUnassociatedUser &&
      optimisticAssociation !== "run" &&
      event.eventType === "input.automation";
    return [
      { event, isQueued, inputCreatedAt: inputCreatedAtById.get(event.id) },
    ];
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

export type RunIndicatorState = "pending" | "running" | "queued" | null;
type ActiveRunIndicatorState = "pending" | "running" | null;

interface RunIndicatorContext {
  readonly terminatedRunIds: ReadonlySet<string>;
  readonly queuedRunIds: ReadonlySet<string>;
}

function runActivityIndicatorState(
  context: RunIndicatorContext,
  runId: string,
): ActiveRunIndicatorState | undefined {
  if (context.terminatedRunIds.has(runId) || context.queuedRunIds.has(runId)) {
    return undefined;
  }
  return "running";
}

function assistantRunIndicatorState(
  context: RunIndicatorContext,
  event: ChatEvent,
): ActiveRunIndicatorState | undefined {
  const runId = event.runId;
  if (isQueueMarkerEvent(event)) {
    return undefined;
  }
  if (isChatRunTerminalEventType(event.eventType)) {
    return null;
  }
  if (runId === undefined) {
    return undefined;
  }
  return runActivityIndicatorState(context, runId);
}

function nonAssistantRunIndicatorState(
  context: RunIndicatorContext,
  event: ChatEvent,
): ActiveRunIndicatorState | undefined {
  if (event.eventType === "input.prompt" && event.runId === undefined) {
    return "pending";
  }
  const { runId } = event;
  return runId === undefined
    ? undefined
    : runActivityIndicatorState(context, runId);
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
  context: RunIndicatorContext,
  revokedEventIds: ReadonlySet<string>,
  runStartIndexByRunId: ReadonlyMap<string, number>,
): "running" | undefined {
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
        ? assistantRunIndicatorState(context, event)
        : nonAssistantRunIndicatorState(context, event);
    if (state === "running") {
      return state;
    }
  }
  return undefined;
}

function activeRunIndicatorStateFromChatEvents(
  events: readonly ChatEvent[],
  revokedEventIds: ReadonlySet<string>,
  context: RunIndicatorContext,
): ActiveRunIndicatorState {
  const runStartIndexByRunId = visibleRunStartIndexByRunId(
    events,
    revokedEventIds,
  );
  let newerPendingState: "pending" | null = null;

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (revokedEventIds.has(event.id)) {
      continue;
    }
    if (isUsageEvent(event) || isGoalMarkerEvent(event)) {
      continue;
    }
    if (chatEventCompatibilityRole(event.eventType) === "assistant") {
      const state = assistantRunIndicatorState(context, event);
      if (state === null && event.runId !== undefined) {
        const laterRunState = laterStartedRunIndicatorState(
          events,
          event.runId,
          context,
          revokedEventIds,
          runStartIndexByRunId,
        );
        if (laterRunState !== undefined) {
          return laterRunState;
        }
      }
      if (state === null) {
        return newerPendingState;
      }
      if (state === "running") {
        return state;
      }
      if (
        event.runId === undefined &&
        (event.eventType === "output.message" ||
          event.eventType === "output.error")
      ) {
        return newerPendingState;
      }
      continue;
    }
    const state = nonAssistantRunIndicatorState(context, event);
    if (state === "running") {
      return state;
    }
    if (state === "pending" && newerPendingState === null) {
      newerPendingState = state;
    }
  }
  return newerPendingState;
}

export function deriveRunIndicatorStateFromChatEvents(
  events: readonly ChatEvent[],
): RunIndicatorState {
  const revokedEventIds = revokedChatEventIds(events);
  const terminatedRunIds = terminatedChatRunIds(events);
  const queuedRunIds = new Set(
    [...foldChatRunStates(events)].flatMap(([runId, state]) => {
      return state === "queued" ? [runId] : [];
    }),
  );
  const activeRunState = activeRunIndicatorStateFromChatEvents(
    events,
    revokedEventIds,
    {
      terminatedRunIds,
      queuedRunIds,
    },
  );
  if (activeRunState === "running") {
    return activeRunState;
  }
  return queuedRunIds.size > 0 ? "queued" : activeRunState;
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

export interface ChatRunModelSelection {
  readonly selectedModel: string;
  readonly serviceTier?: ChatThreadServiceTier;
}

export function runningModelSelectionFromChatEvents(
  events: readonly ChatEvent[],
): ChatRunModelSelection | null {
  const runningRunId = liveRunIdsFromChatEvents(events).at(-1);
  if (runningRunId === undefined) {
    return null;
  }

  const revokedEventIds = revokedChatEventIds(events);
  for (const event of events) {
    if (
      event.eventType !== "input.prompt" ||
      event.runId !== runningRunId ||
      revokedEventIds.has(event.id)
    ) {
      continue;
    }
    const model = event.userMessage.parts.find((part) => {
      return part.type === "model";
    });
    if (model?.type === "model") {
      return {
        selectedModel: model.selectedModel,
        ...(model.serviceTier === undefined
          ? {}
          : { serviceTier: model.serviceTier }),
      };
    }
  }
  return null;
}
