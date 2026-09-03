import { command, computed, state } from "ccstate";
import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  isChatEventContentTextType,
  isChatRunTerminalEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";

const internalRunWorkExpandedKeys$ = state<Set<string>>(new Set());

export const runWorkExpandedKeys$ = computed((get): Set<string> => {
  return get(internalRunWorkExpandedKeys$);
});

export const toggleRunWorkExpanded$ = command(({ set }, key: string) => {
  set(internalRunWorkExpandedKeys$, (prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
});

export interface RunWorkSection {
  readonly key: string;
  readonly anchorEventId: string;
  readonly hiddenGroups: ChatEventGroup[];
  readonly startTime: number;
  readonly endTime?: number;
}

export interface RunWorkFolding {
  readonly visibleGroups: ChatEventGroup[];
  readonly sectionsByAnchorEventId: Map<string, RunWorkSection>;
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

function isRunWorkAssistantEvent(event: EnrichedChatEvent): boolean {
  return event.eventType !== "run.queued" && isRenderableAssistantEvent(event);
}

export function runWorkSectionForGroup(
  runWorkFolding: RunWorkFolding | null,
  group: ChatEventGroup,
): RunWorkSection | null {
  if (runWorkFolding === null) {
    return null;
  }
  return (
    group.events
      .map((event) => {
        return runWorkFolding.sectionsByAnchorEventId.get(event.id);
      })
      .find((section) => {
        return section !== undefined;
      }) ?? null
  );
}

export function runWorkExpandedKeysForScrollTarget(
  folding: RunWorkFolding | null,
  expandedKeys: ReadonlySet<string>,
  targetEventId: string | null,
): ReadonlySet<string> {
  if (folding === null || targetEventId === null) {
    return expandedKeys;
  }
  const targetSection = Array.from(
    folding.sectionsByAnchorEventId.values(),
  ).find((section) => {
    return section.hiddenGroups.some((group) => {
      return group.events.some((event) => {
        return event.id === targetEventId;
      });
    });
  });
  if (!targetSection || expandedKeys.has(targetSection.key)) {
    return expandedKeys;
  }
  const next = new Set(expandedKeys);
  next.add(targetSection.key);
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

function groupEventsForRunWorkDisplay(
  events: readonly EnrichedChatEvent[],
  workAnchorEventIds: ReadonlySet<string>,
): ChatEventGroup[] {
  const groups: ChatEventGroup[] = [];
  for (const event of events) {
    const role = chatEventCompatibilityRole(event.eventType);
    const forceStandalone = workAnchorEventIds.has(event.id);
    const last = groups[groups.length - 1];
    const lastHasWorkAnchor =
      last?.events.some((candidate) => {
        return workAnchorEventIds.has(candidate.id);
      }) ?? false;

    if (!forceStandalone && last && last.role === role && !lastHasWorkAnchor) {
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

function attachUsageToRunWorkGroups(
  groups: readonly ChatEventGroup[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
  workAnchorEventIds: ReadonlySet<string>,
): ChatEventGroup[] {
  const lastAssistantGroupIndexByRunId = new Map<string, number>();
  for (const [index, group] of groups.entries()) {
    if (
      group.role !== "assistant" ||
      (!group.events.some(isRenderableAssistantEvent) &&
        !group.events.some((event) => {
          return workAnchorEventIds.has(event.id);
        }))
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

function splitRunWorkEventsAtUsers(
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

function eventTime(event: EnrichedChatEvent | undefined): number | null {
  if (event === undefined) {
    return null;
  }
  const timestamp = Date.parse(event.createdAt);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function firstEventTime(events: readonly EnrichedChatEvent[]): number | null {
  for (const event of events) {
    const timestamp = eventTime(event);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

function lastEventTime(events: readonly EnrichedChatEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const timestamp = eventTime(events[index]);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

function lastEventMatching(
  events: readonly EnrichedChatEvent[],
  predicate: (event: EnrichedChatEvent) => boolean,
): EnrichedChatEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (predicate(event)) {
      return event;
    }
  }
  return undefined;
}

interface RunWorkPhaseFolding {
  readonly visibleEvents: readonly EnrichedChatEvent[];
  readonly section: RunWorkSection | null;
}

function foldRunWorkPhase(
  runId: string,
  events: readonly EnrichedChatEvent[],
  endTime: number | undefined,
): RunWorkPhaseFolding {
  const latestAssistantEvent = lastEventMatching(
    events,
    isRunWorkAssistantEvent,
  );
  const terminalEvent = lastEventMatching(events, (event) => {
    return isChatRunTerminalEventType(event.eventType);
  });
  const anchorEvent = latestAssistantEvent ?? terminalEvent;
  const startTime = firstEventTime(events);
  if (anchorEvent === undefined || startTime === null) {
    return { visibleEvents: events, section: null };
  }

  const anchorIndex = events.indexOf(anchorEvent);
  const hiddenEvents = events.slice(0, anchorIndex).filter((event) => {
    return isRunWorkAssistantEvent(event);
  });
  const userEvents = events.filter((event) => {
    return chatEventCompatibilityRole(event.eventType) === "user";
  });

  return {
    visibleEvents: [...userEvents, anchorEvent],
    section: {
      key: `${runId}:${events[0]!.id}`,
      anchorEventId: anchorEvent.id,
      hiddenGroups: groupEventsByRole(hiddenEvents),
      startTime,
      ...(endTime === undefined ? {} : { endTime }),
    },
  };
}

function terminalEventForRun(
  events: readonly EnrichedChatEvent[],
): EnrichedChatEvent | undefined {
  return lastEventMatching(events, (event) => {
    return isChatRunTerminalEventType(event.eventType);
  });
}

function phaseEndTime(
  phase: readonly EnrichedChatEvent[],
  isFinalPhase: boolean,
  terminalEvent: EnrichedChatEvent | undefined,
): number | undefined {
  if (!isFinalPhase) {
    return lastEventTime(phase) ?? undefined;
  }
  if (terminalEvent === undefined) {
    return undefined;
  }
  return eventTime(terminalEvent) ?? lastEventTime(phase) ?? undefined;
}

export function buildRunWorkFolding(
  groups: readonly ChatEventGroup[],
): RunWorkFolding | null {
  const usageByRunId = usageByRunIdFromGroups(groups);
  const events = groups.flatMap((group) => {
    return group.events;
  });
  const visibleEvents: EnrichedChatEvent[] = [];
  const sections: RunWorkSection[] = [];

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
    if (runEvents.some(isCancelledRunEvent)) {
      visibleEvents.push(...runEvents);
      index = endIndex;
      continue;
    }

    const terminalEvent = terminalEventForRun(runEvents);
    const phases = splitRunWorkEventsAtUsers(runEvents);
    for (const [phaseIndex, phase] of phases.entries()) {
      const phaseFolding = foldRunWorkPhase(
        runId,
        phase,
        phaseEndTime(phase, phaseIndex === phases.length - 1, terminalEvent),
      );
      visibleEvents.push(...phaseFolding.visibleEvents);
      if (phaseFolding.section !== null) {
        sections.push(phaseFolding.section);
      }
    }

    index = endIndex;
  }

  if (sections.length === 0) {
    return null;
  }

  const workAnchorEventIds = new Set(
    sections.map((section) => {
      return section.anchorEventId;
    }),
  );
  return {
    visibleGroups: attachUsageToRunWorkGroups(
      groupEventsForRunWorkDisplay(visibleEvents, workAnchorEventIds),
      usageByRunId,
      workAnchorEventIds,
    ),
    sectionsByAnchorEventId: new Map(
      sections.map((section) => {
        return [section.anchorEventId, section];
      }),
    ),
  };
}

/** Match the event ordering inside each outer page row after fold expansion. */
export function applyRunWorkExpansion(
  groups: readonly ChatEventGroup[],
  folding: RunWorkFolding | null,
  expandedKeys: ReadonlySet<string>,
): ChatEventGroup[] {
  const visibleGroups = folding?.visibleGroups ?? groups;
  return visibleGroups.map((group) => {
    const section = runWorkSectionForGroup(folding, group);
    if (section === null || !expandedKeys.has(section.key)) {
      return group;
    }
    return {
      ...group,
      events: [
        ...section.hiddenGroups.flatMap((hiddenGroup) => {
          return hiddenGroup.events;
        }),
        ...group.events,
      ],
    };
  });
}
