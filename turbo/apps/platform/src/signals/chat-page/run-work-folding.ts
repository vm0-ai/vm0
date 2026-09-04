import { command, computed, state } from "ccstate";
import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  isChatEventContentTextType,
  isChatInputEventType,
  isChatRunTerminalEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { hasChatEventBodyContent } from "./chat-event-body-blocks.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import { isGoalContinuationInput, type ChatEvent } from "./chat-event-types.ts";
import { mergeChatEventUsagePayloads } from "./chat-event-usage.ts";
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
  readonly hiddenGroupsAfterAnchor: ChatEventGroup[];
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

function isRunWorkAssistantOutput(event: EnrichedChatEvent): boolean {
  return (
    event.eventType !== "run.queued" &&
    !isCancelledRunEvent(event) &&
    isRenderableAssistantEvent(event)
  );
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
    return [...section.hiddenGroups, ...section.hiddenGroupsAfterAnchor].some(
      (group) => {
        return group.events.some((event) => {
          return event.id === targetEventId;
        });
      },
    );
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
    const joinsWorkAnchor = lastHasWorkAnchor && isCancelledRunEvent(event);

    if (
      !forceStandalone &&
      last &&
      last.role === role &&
      (!lastHasWorkAnchor || joinsWorkAnchor)
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

function attachUsageToRunWorkGroups(
  groups: readonly ChatEventGroup[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
  usageByAnchorEventId: ReadonlyMap<string, ChatEventUsagePayload>,
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
    const anchorUsage = group.events
      .map((event) => {
        return usageByAnchorEventId.get(event.id);
      })
      .find((usage) => {
        return usage !== undefined;
      });
    if (anchorUsage !== undefined) {
      return { ...group, usage: anchorUsage };
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

interface RunWorkEventSegment {
  readonly runId: string | undefined;
  runGroupId: string | undefined;
  readonly events: EnrichedChatEvent[];
}

interface RunWorkUnit {
  readonly key: string | undefined;
  readonly runGroupId: string | undefined;
  readonly events: readonly EnrichedChatEvent[];
  readonly runIds: readonly string[];
  readonly hiddenUserEventIds: ReadonlySet<string>;
  readonly isGoal: boolean;
}

function runWorkEventSegments(
  events: readonly EnrichedChatEvent[],
): RunWorkEventSegment[] {
  const segments: RunWorkEventSegment[] = [];
  for (const event of events) {
    const runId =
      event.runId ??
      (event.eventType === "control.interrupt"
        ? event.interruptsRunId
        : undefined);
    const last = segments[segments.length - 1];
    if (runId !== undefined && last?.runId === runId) {
      last.events.push(event);
      if (last.runGroupId === undefined) {
        last.runGroupId = event.runGroupId;
      }
      continue;
    }
    segments.push({
      runId,
      runGroupId: event.runGroupId,
      events: [event],
    });
  }
  return segments;
}

function runGroupStreakEndIndex(
  segments: readonly RunWorkEventSegment[],
  startIndex: number,
  runGroupId: string,
): number {
  let endIndex = startIndex + 1;
  while (
    endIndex < segments.length &&
    segments[endIndex]?.runGroupId === runGroupId
  ) {
    endIndex++;
  }
  return endIndex;
}

function uniqueRunIds(segments: readonly RunWorkEventSegment[]): string[] {
  return Array.from(
    new Set(
      segments.flatMap((segment) => {
        return segment.runId === undefined ? [] : [segment.runId];
      }),
    ),
  );
}

function standaloneRunWorkUnit(segment: RunWorkEventSegment): RunWorkUnit {
  return {
    key: segment.runId,
    runGroupId: segment.runGroupId,
    events: segment.events,
    runIds: segment.runId === undefined ? [] : [segment.runId],
    hiddenUserEventIds: new Set(),
    isGoal: false,
  };
}

function canAnchorGoalRun(unit: RunWorkUnit | undefined): boolean {
  return unit !== undefined && !unit.isGoal && unit.runGroupId === undefined;
}

function runWorkUnits(events: readonly EnrichedChatEvent[]): RunWorkUnit[] {
  const segments = runWorkEventSegments(events);
  const units: RunWorkUnit[] = [];

  for (let index = 0; index < segments.length; ) {
    const segment = segments[index]!;
    if (segment.runGroupId === undefined) {
      units.push(standaloneRunWorkUnit(segment));
      index++;
      continue;
    }

    const endIndex = runGroupStreakEndIndex(
      segments,
      index,
      segment.runGroupId,
    );
    const streak = segments.slice(index, endIndex);
    const goalInputEvents = streak.flatMap((item) => {
      return item.events.filter(isGoalContinuationInput);
    });
    if (goalInputEvents.length === 0) {
      units.push(...streak.map(standaloneRunWorkUnit));
      index = endIndex;
      continue;
    }

    // Goal continuations are synthetic user turns. Attach their contiguous
    // streak to the nearest preceding ungrouped run; an intervening run then
    // naturally starts a new visual work section after an interruption.
    const previousUnit = units[units.length - 1];
    const anchorUnit = canAnchorGoalRun(previousUnit) ? units.pop() : undefined;
    const hiddenUserEventIds = new Set(
      goalInputEvents.map((event) => {
        return event.id;
      }),
    );
    // A render window can begin inside a goal streak. Keep one context row when
    // its triggering run is outside the window instead of orphaning the work.
    if (anchorUnit === undefined) {
      hiddenUserEventIds.delete(goalInputEvents[0]!.id);
    }
    const goalRunIds = uniqueRunIds(streak);
    units.push({
      key: `goal:${segment.runGroupId}`,
      runGroupId: segment.runGroupId,
      events: [
        ...(anchorUnit?.events ?? []),
        ...streak.flatMap((item) => {
          return item.events;
        }),
      ],
      runIds: [...(anchorUnit?.runIds ?? []), ...goalRunIds],
      hiddenUserEventIds,
      isGoal: true,
    });
    index = endIndex;
  }

  return units;
}

function visibleRunWorkUserEvent(
  event: EnrichedChatEvent,
  hiddenUserEventIds: ReadonlySet<string>,
): boolean {
  return (
    isChatInputEventType(event.eventType) && !hiddenUserEventIds.has(event.id)
  );
}

function splitRunWorkEventsAtUsers(
  events: readonly EnrichedChatEvent[],
  hiddenUserEventIds: ReadonlySet<string>,
): EnrichedChatEvent[][] {
  const phases: EnrichedChatEvent[][] = [];
  let phase: EnrichedChatEvent[] = [];
  for (const event of events) {
    if (
      phase.length > 0 &&
      visibleRunWorkUserEvent(event, hiddenUserEventIds)
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
  key: string,
  events: readonly EnrichedChatEvent[],
  endTime: number | undefined,
  hiddenUserEventIds: ReadonlySet<string>,
  foldedEventIds: ReadonlySet<string>,
): RunWorkPhaseFolding {
  const latestAssistantOutput = lastEventMatching(
    events,
    isRunWorkAssistantOutput,
  );
  const terminalEvent = lastEventMatching(events, (event) => {
    return isChatRunTerminalEventType(event.eventType);
  });
  const anchorEvent = latestAssistantOutput ?? terminalEvent;
  const startTime = firstEventTime(events);
  if (anchorEvent === undefined || startTime === null) {
    return {
      visibleEvents: events.filter((event) => {
        return !hiddenUserEventIds.has(event.id);
      }),
      section: null,
    };
  }

  const anchorIndex = events.indexOf(anchorEvent);
  const hiddenEvents = events.slice(0, anchorIndex).filter((event) => {
    return (
      isRunWorkAssistantOutput(event) ||
      (hiddenUserEventIds.has(event.id) && foldedEventIds.has(event.id))
    );
  });
  const hiddenEventsAfterAnchor = events
    .slice(anchorIndex + 1)
    .filter((event) => {
      return hiddenUserEventIds.has(event.id) && foldedEventIds.has(event.id);
    });
  const hiddenEventIds = new Set(
    [...hiddenEvents, ...hiddenEventsAfterAnchor].map((event) => {
      return event.id;
    }),
  );
  const trailingStatusEvents = events.slice(anchorIndex + 1).filter((event) => {
    return (
      !hiddenEventIds.has(event.id) &&
      !hiddenUserEventIds.has(event.id) &&
      isRenderableAssistantEvent(event) &&
      !isRunWorkAssistantOutput(event)
    );
  });
  const userEvents = events.filter((event) => {
    return visibleRunWorkUserEvent(event, hiddenUserEventIds);
  });

  return {
    visibleEvents: [...userEvents, anchorEvent, ...trailingStatusEvents],
    section: {
      key: `${key}:${events[0]!.id}`,
      anchorEventId: anchorEvent.id,
      hiddenGroups: groupEventsByRole(hiddenEvents),
      hiddenGroupsAfterAnchor: groupEventsByRole(hiddenEventsAfterAnchor),
      startTime,
      ...(endTime === undefined ? {} : { endTime }),
    },
  };
}

function latestRunIdForEvents(
  events: readonly EnrichedChatEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const runId = events[index]?.runId;
    if (runId !== undefined) {
      return runId;
    }
  }
  return undefined;
}

function terminalEventForLatestRun(
  events: readonly EnrichedChatEvent[],
): EnrichedChatEvent | undefined {
  const latestRunId = latestRunIdForEvents(events);
  if (latestRunId === undefined) {
    return undefined;
  }
  return lastEventMatching(events, (event) => {
    return (
      event.runId === latestRunId && isChatRunTerminalEventType(event.eventType)
    );
  });
}

function mergedUsageForRunIds(
  runIds: readonly string[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
): ChatEventUsagePayload | undefined {
  return mergeChatEventUsagePayloads(
    runIds.flatMap((runId) => {
      const usage = usageByRunId.get(runId);
      return usage === undefined ? [] : [usage];
    }),
  );
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
  foldedEventIds: ReadonlySet<string> = new Set(),
): RunWorkFolding | null {
  const usageByRunId = usageByRunIdFromGroups(groups);
  const events = groups.flatMap((group) => {
    return group.events;
  });
  const visibleEvents: EnrichedChatEvent[] = [];
  const sections: RunWorkSection[] = [];
  const usageByAnchorEventId = new Map<string, ChatEventUsagePayload>();

  for (const unit of runWorkUnits(events)) {
    if (unit.key === undefined) {
      visibleEvents.push(
        ...unit.events.filter((event) => {
          return !unit.hiddenUserEventIds.has(event.id);
        }),
      );
      continue;
    }

    const terminalEvent = terminalEventForLatestRun(unit.events);
    const phases = splitRunWorkEventsAtUsers(
      unit.events,
      unit.hiddenUserEventIds,
    );
    const firstSectionIndex = sections.length;
    for (const [phaseIndex, phase] of phases.entries()) {
      const phaseFolding = foldRunWorkPhase(
        unit.key,
        phase,
        phaseEndTime(phase, phaseIndex === phases.length - 1, terminalEvent),
        unit.hiddenUserEventIds,
        foldedEventIds,
      );
      visibleEvents.push(...phaseFolding.visibleEvents);
      if (phaseFolding.section !== null) {
        sections.push(phaseFolding.section);
      }
    }
    if (unit.isGoal && sections.length > firstSectionIndex) {
      const mergedUsage = mergedUsageForRunIds(unit.runIds, usageByRunId);
      const finalSection = sections[sections.length - 1];
      if (mergedUsage !== undefined && finalSection !== undefined) {
        usageByAnchorEventId.set(finalSection.anchorEventId, mergedUsage);
      }
    }
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
      usageByAnchorEventId,
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
    const anchorIndex = group.events.findIndex((event) => {
      return event.id === section.anchorEventId;
    });
    const anchorEndIndex =
      anchorIndex === -1 ? group.events.length : anchorIndex + 1;
    return {
      ...group,
      events: [
        ...section.hiddenGroups.flatMap((hiddenGroup) => {
          return hiddenGroup.events;
        }),
        ...group.events.slice(0, anchorEndIndex),
        ...section.hiddenGroupsAfterAnchor.flatMap((hiddenGroup) => {
          return hiddenGroup.events;
        }),
        ...group.events.slice(anchorEndIndex),
      ],
    };
  });
}
