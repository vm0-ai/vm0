import { command, computed, state } from "ccstate";
import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  isChatEventContentTextType,
  terminatedChatRunIds,
} from "@okouai/api-contracts/contracts/chat-events";
import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";

const internalCompletedWorkExpandedKeys$ = state<Set<string>>(new Set());

export const completedWorkExpandedKeys$ = computed((get): Set<string> => {
  return get(internalCompletedWorkExpandedKeys$);
});

export const toggleCompletedWorkExpanded$ = command(({ set }, key: string) => {
  set(internalCompletedWorkExpandedKeys$, (prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
});

export interface CompletedWorkFold {
  readonly key: string;
  readonly finalEventId: string;
  readonly hiddenGroups: ChatEventGroup[];
  readonly labelGroups: ChatEventGroup[];
}

export interface CompletedWorkFolding {
  readonly visibleGroups: ChatEventGroup[];
  readonly foldsByFinalEventId: Map<string, CompletedWorkFold>;
}

export function chatEventDisplayError(event: ChatEvent): string | undefined {
  if (
    event.eventType === "input.rejected" ||
    event.eventType === "output.error" ||
    event.eventType === "run.failed" ||
    event.eventType === "run.cancelled"
  ) {
    return event.error;
  }
  return undefined;
}

function chatEventHasAttachments(event: EnrichedChatEvent): boolean {
  return (
    "userMessage" in event &&
    (event.userMessage?.parts.some((part) => {
      return part.type === "file";
    }) ??
      false)
  );
}

export function isRenderableAssistantEvent(event: EnrichedChatEvent): boolean {
  return (
    chatEventCompatibilityRole(event.eventType) === "assistant" &&
    ((isChatEventContentTextType(event.eventType) && Boolean(event.content)) ||
      Boolean(chatEventDisplayError(event)) ||
      hasChatEventBodyContent(event) ||
      chatEventHasAttachments(event))
  );
}

export function completedWorkFoldForGroup(
  completedWorkFolding: CompletedWorkFolding | null,
  group: ChatEventGroup,
): CompletedWorkFold | null {
  if (completedWorkFolding === null) {
    return null;
  }
  return (
    group.events
      .map((event) => {
        return completedWorkFolding.foldsByFinalEventId.get(event.id);
      })
      .find((fold) => {
        return fold !== undefined;
      }) ?? null
  );
}

export function completedWorkExpandedKeysForScrollTarget(
  folding: CompletedWorkFolding | null,
  expandedKeys: ReadonlySet<string>,
  targetEventId: string | null,
): ReadonlySet<string> {
  if (folding === null || targetEventId === null) {
    return expandedKeys;
  }
  const targetFold = Array.from(folding.foldsByFinalEventId.values()).find(
    (fold) => {
      return fold.hiddenGroups.some((group) => {
        return group.events.some((event) => {
          return event.id === targetEventId;
        });
      });
    },
  );
  if (!targetFold || expandedKeys.has(targetFold.key)) {
    return expandedKeys;
  }
  const next = new Set(expandedKeys);
  next.add(targetFold.key);
  return next;
}

function groupEventsByRole(
  events: readonly EnrichedChatEvent[],
): ChatEventGroup[] {
  const groups: ChatEventGroup[] = [];
  for (const event of events) {
    const role = chatEventCompatibilityRole(event.eventType);
    const last = groups[groups.length - 1];
    if (last && last.role === role) {
      last.events.push(event);
      continue;
    }
    groups.push({
      beginEventId: event.id,
      role,
      events: [event],
    });
  }
  return groups;
}

function groupEventsForCompletedWorkDisplay(
  events: readonly EnrichedChatEvent[],
  foldFinalEventIds: ReadonlySet<string>,
): ChatEventGroup[] {
  const groups: ChatEventGroup[] = [];
  for (const event of events) {
    const role = chatEventCompatibilityRole(event.eventType);
    const forceStandalone = foldFinalEventIds.has(event.id);
    const last = groups[groups.length - 1];
    const lastHasFoldFinal =
      last?.events.some((candidate) => {
        return foldFinalEventIds.has(candidate.id);
      }) ?? false;
    const lastFoldFinal = last?.events.find((candidate) => {
      return foldFinalEventIds.has(candidate.id);
    });
    const continuesFoldFinalRun =
      lastFoldFinal?.runId !== undefined && lastFoldFinal.runId === event.runId;

    if (
      !forceStandalone &&
      last &&
      last.role === role &&
      (!lastHasFoldFinal || continuesFoldFinalRun)
    ) {
      last.events.push(event);
      continue;
    }

    groups.push({
      beginEventId: event.id,
      role,
      events: [event],
    });
  }
  return groups;
}

function firstRunIdForEvents(
  events: readonly EnrichedChatEvent[],
): string | undefined {
  return events.find((event) => {
    return event.runId !== undefined;
  })?.runId;
}

function usageByRunIdFromGroups(
  groups: readonly ChatEventGroup[],
): Map<string, ChatEventUsagePayload> {
  return foldLatestChatUsageByRunId(
    groups.flatMap((group) => {
      const runId = firstRunIdForEvents(group.events);
      return group.role === "assistant" &&
        group.usage !== undefined &&
        runId !== undefined
        ? [
            {
              eventType: "usage.recorded" as const,
              runId,
              usage: group.usage,
            },
          ]
        : [];
    }),
  );
}

function attachUsageToCompletedWorkGroups(
  groups: readonly ChatEventGroup[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
): ChatEventGroup[] {
  const lastAssistantGroupIndexByRunId = new Map<string, number>();
  for (const [index, group] of groups.entries()) {
    if (
      group.role !== "assistant" ||
      !group.events.some(isRenderableAssistantEvent)
    ) {
      continue;
    }
    const runId = firstRunIdForEvents(group.events);
    if (runId !== undefined) {
      lastAssistantGroupIndexByRunId.set(runId, index);
    }
  }
  return groups.map((group, index) => {
    if (group.role !== "assistant") {
      return group;
    }
    const runId = firstRunIdForEvents(group.events);
    if (
      runId === undefined ||
      lastAssistantGroupIndexByRunId.get(runId) !== index
    ) {
      return group;
    }
    const usage = usageByRunId.get(runId);
    return usage === undefined ? group : { ...group, usage };
  });
}

function isThinkingOnlyAssistantEvent(event: EnrichedChatEvent): boolean {
  return (
    event.eventType === "output.thinking" && event.thinking.trim().length > 0
  );
}

function splitCompletedWorkEventsAtUsers(
  events: readonly EnrichedChatEvent[],
): EnrichedChatEvent[][] {
  const phases: EnrichedChatEvent[][] = [];
  let phase: EnrichedChatEvent[] = [];
  for (const event of events) {
    if (
      phase.length > 0 &&
      chatEventCompatibilityRole(event.eventType) === "user"
    ) {
      phases.push(phase);
      phase = [];
    }
    phase.push(event);
  }
  if (phase.length > 0) {
    phases.push(phase);
  }
  return phases;
}

function lastCompletedWorkEventIndex(
  events: readonly EnrichedChatEvent[],
  predicate: (event: EnrichedChatEvent) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index--) {
    if (predicate(events[index]!)) {
      return index;
    }
  }
  return -1;
}

function completedWorkFinalEventIndex(
  events: readonly EnrichedChatEvent[],
): number {
  return lastCompletedWorkEventIndex(events, isRenderableAssistantEvent);
}

function canFoldCompletedWorkTrailingEvent(event: EnrichedChatEvent): boolean {
  const role = chatEventCompatibilityRole(event.eventType);
  return (
    role === "user" ||
    (role === "assistant" && !isRenderableAssistantEvent(event))
  );
}

interface CompletedWorkPhaseFolding {
  readonly visibleEvents: readonly EnrichedChatEvent[];
  readonly fold: CompletedWorkFold | null;
}

function foldCompletedWorkPhase(
  runId: string,
  events: readonly EnrichedChatEvent[],
): CompletedWorkPhaseFolding {
  const finalEventIndex = completedWorkFinalEventIndex(events);
  const finalEvent =
    finalEventIndex >= 0 ? events[finalEventIndex]! : undefined;
  const precedingEvents =
    finalEventIndex > 0 ? events.slice(0, finalEventIndex) : [];
  const hiddenEvents = precedingEvents.filter((event) => {
    return (
      chatEventCompatibilityRole(event.eventType) !== "user" &&
      !isThinkingOnlyAssistantEvent(event)
    );
  });
  const userEvents = events.filter((event) => {
    return chatEventCompatibilityRole(event.eventType) === "user";
  });
  const trailingEvents =
    finalEventIndex >= 0 ? events.slice(finalEventIndex + 1) : [];
  const trailingEventsCanFold = trailingEvents.every((event) => {
    return canFoldCompletedWorkTrailingEvent(event);
  });
  if (
    finalEvent === undefined ||
    hiddenEvents.length === 0 ||
    !trailingEventsCanFold
  ) {
    return { visibleEvents: events, fold: null };
  }
  return {
    visibleEvents: [
      ...userEvents,
      finalEvent,
      ...trailingEvents.filter(isRenderableAssistantEvent),
    ],
    fold: {
      key: `${runId}:${finalEvent.id}`,
      finalEventId: finalEvent.id,
      hiddenGroups: groupEventsByRole(hiddenEvents),
      labelGroups: groupEventsByRole(events),
    },
  };
}

export function buildCompletedWorkFolding(
  groups: readonly ChatEventGroup[],
): CompletedWorkFolding | null {
  const usageByRunId = usageByRunIdFromGroups(groups);
  const events = groups.flatMap((group) => {
    return group.events;
  });
  const terminatedRunIds = terminatedChatRunIds(events);
  const visibleEvents: EnrichedChatEvent[] = [];
  const folds: CompletedWorkFold[] = [];
  let hasCompletedWorkPhaseBoundary = false;

  for (let index = 0; index < events.length; ) {
    const runId = events[index]!.runId;
    if (runId === undefined) {
      visibleEvents.push(events[index]!);
      index++;
      continue;
    }

    let endIndex = index + 1;
    while (endIndex < events.length && events[endIndex]!.runId === runId) {
      endIndex++;
    }

    const runEvents = events.slice(index, endIndex);
    if (!terminatedRunIds.has(runId) || runEvents.some(isCancelledRunEvent)) {
      visibleEvents.push(...runEvents);
      index = endIndex;
      continue;
    }

    const completedWorkEventGroups = splitCompletedWorkEventsAtUsers(runEvents);
    if (completedWorkEventGroups.length > 1) {
      hasCompletedWorkPhaseBoundary = true;
    }
    for (const completedWorkEvents of completedWorkEventGroups) {
      const phaseFolding = foldCompletedWorkPhase(runId, completedWorkEvents);
      visibleEvents.push(...phaseFolding.visibleEvents);
      if (phaseFolding.fold !== null) {
        folds.push(phaseFolding.fold);
      }
    }

    index = endIndex;
  }

  if (folds.length === 0 && !hasCompletedWorkPhaseBoundary) {
    return null;
  }

  const foldFinalEventIds = new Set(
    folds.map((fold) => {
      return fold.finalEventId;
    }),
  );
  return {
    visibleGroups: attachUsageToCompletedWorkGroups(
      groupEventsForCompletedWorkDisplay(visibleEvents, foldFinalEventIds),
      usageByRunId,
    ),
    foldsByFinalEventId: new Map(
      folds.map((fold) => {
        return [fold.finalEventId, fold];
      }),
    ),
  };
}

/** Match the event ordering inside each outer page row after fold expansion. */
export function applyCompletedWorkExpansion(
  groups: readonly ChatEventGroup[],
  folding: CompletedWorkFolding | null,
  expandedKeys: ReadonlySet<string>,
): ChatEventGroup[] {
  const visibleGroups = folding?.visibleGroups ?? groups;
  return visibleGroups.map((group) => {
    const fold = completedWorkFoldForGroup(folding, group);
    if (fold === null || !expandedKeys.has(fold.key)) {
      return group;
    }
    return {
      ...group,
      events: [
        ...fold.hiddenGroups.flatMap((hiddenGroup) => {
          return hiddenGroup.events;
        }),
        ...group.events,
      ],
    };
  });
}
