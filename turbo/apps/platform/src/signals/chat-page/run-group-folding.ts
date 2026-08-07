import { command, computed, state } from "ccstate";
import type { EnrichedChatEvent, ChatEventGroup } from "./chat-event.ts";
import type { ChatEventUsagePayload } from "@vm0/api-contracts/contracts/chat-threads";
import { chatEventCompatibilityRole } from "@vm0/api-contracts/contracts/chat-events";

interface RunSegment {
  readonly runId: string;
  runGroupId: string | undefined;
  readonly events: EnrichedChatEvent[];
  readonly startGroupIndex: number;
  endGroupIndex: number;
}

interface LooseSegment {
  readonly runId: undefined;
  readonly runGroupId: undefined;
  readonly events: EnrichedChatEvent[];
  readonly startGroupIndex: number;
  endGroupIndex: number;
}

type EventSegment = RunSegment | LooseSegment;

type GroupedRunSegment = RunSegment & { runGroupId: string };

export interface RunGroupFold {
  readonly key: string;
  readonly runGroupId: string;
  readonly hiddenRunCount: number;
  readonly hiddenGroups: ChatEventGroup[];
  readonly labelGroups: ChatEventGroup[];
  readonly expanded: boolean;
}

export interface RunGroupFolding {
  readonly visibleGroups: ChatEventGroup[];
  readonly foldsByNextGroupId: ReadonlyMap<string, readonly RunGroupFold[]>;
}

const internalRunGroupExpansionOverrides$ = state<Map<string, boolean>>(
  new Map(),
);

export const runGroupExpansionOverrides$ = computed(
  (get): ReadonlyMap<string, boolean> => {
    return get(internalRunGroupExpansionOverrides$);
  },
);

export const toggleRunGroupExpanded$ = command(
  ({ set }, key: string, expanded: boolean) => {
    set(internalRunGroupExpansionOverrides$, (prev) => {
      const next = new Map(prev);
      next.set(key, !expanded);
      return next;
    });
  },
);

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
  const usageByRunId = new Map<string, ChatEventUsagePayload>();
  for (const group of groups) {
    if (group.role !== "assistant" || group.usage === undefined) {
      continue;
    }
    const runId = firstRunIdForEvents(group.events);
    if (runId !== undefined) {
      setLatestUsageForRun(usageByRunId, runId, group.usage);
    }
  }
  return usageByRunId;
}

function usageSettledAtMs(usage: ChatEventUsagePayload): number {
  const timestamp = Date.parse(usage.settledAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function setLatestUsageForRun(
  usageByRunId: Map<string, ChatEventUsagePayload>,
  runId: string,
  usage: ChatEventUsagePayload,
): void {
  const existing = usageByRunId.get(runId);
  if (
    existing === undefined ||
    usageSettledAtMs(usage) >= usageSettledAtMs(existing)
  ) {
    usageByRunId.set(runId, usage);
  }
}

interface UsageBreakdownAccumulator {
  readonly kind: string;
  credits: number;
  readonly providers: Map<string, number>;
}

function mergeUsagePayloads(
  usages: readonly ChatEventUsagePayload[],
): ChatEventUsagePayload | undefined {
  if (usages.length === 0) {
    return undefined;
  }

  let totalCredits = 0;
  let settledAt = "";
  const breakdownByKind = new Map<string, UsageBreakdownAccumulator>();

  for (const usage of usages) {
    totalCredits += usage.totalCredits;
    settledAt = usage.settledAt;

    for (const kindBreakdown of usage.breakdown) {
      let accumulator = breakdownByKind.get(kindBreakdown.kind);
      if (accumulator === undefined) {
        accumulator = {
          kind: kindBreakdown.kind,
          credits: 0,
          providers: new Map(),
        };
        breakdownByKind.set(kindBreakdown.kind, accumulator);
      }

      accumulator.credits += kindBreakdown.credits;

      for (const providerBreakdown of kindBreakdown.providers) {
        accumulator.providers.set(
          providerBreakdown.provider,
          (accumulator.providers.get(providerBreakdown.provider) ?? 0) +
            providerBreakdown.credits,
        );
      }
    }
  }

  return {
    version: 1,
    totalCredits,
    settledAt,
    breakdown: Array.from(breakdownByKind.values()).map((accumulator) => {
      return {
        kind: accumulator.kind,
        credits: accumulator.credits,
        providers: Array.from(accumulator.providers.entries()).map(
          ([provider, credits]) => {
            return { provider, credits };
          },
        ),
      };
    }),
  };
}

function mergedUsageForRunSegments(
  runSegments: readonly GroupedRunSegment[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
): ChatEventUsagePayload | undefined {
  const usages: ChatEventUsagePayload[] = [];
  for (const segment of runSegments) {
    const usage = usageByRunId.get(segment.runId);
    if (usage !== undefined) {
      usages.push(usage);
    }
  }
  return mergeUsagePayloads(usages);
}

function attachUsageToGroups(
  groups: readonly ChatEventGroup[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
): ChatEventGroup[] {
  return groups.map((group) => {
    if (group.role !== "assistant") {
      return group;
    }
    const runId = firstRunIdForEvents(group.events);
    const usage = runId === undefined ? undefined : usageByRunId.get(runId);
    return usage === undefined ? group : { ...group, usage };
  });
}

function segmentGroups(
  segment: EventSegment,
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
): ChatEventGroup[] {
  return attachUsageToGroups(groupEventsByRole(segment.events), usageByRunId);
}

function eventSegmentsFromGroups(
  groups: readonly ChatEventGroup[],
): EventSegment[] {
  const segments: EventSegment[] = [];

  for (const [groupIndex, group] of groups.entries()) {
    for (const event of group.events) {
      const runId = event.runId;
      if (runId === undefined) {
        segments.push({
          runId: undefined,
          runGroupId: undefined,
          events: [event],
          startGroupIndex: groupIndex,
          endGroupIndex: groupIndex + 1,
        });
        continue;
      }

      const last = segments[segments.length - 1];
      if (last?.runId === runId) {
        last.events.push(event);
        last.endGroupIndex = groupIndex + 1;
        if (last.runGroupId === undefined) {
          last.runGroupId = event.runGroupId;
        }
        continue;
      }

      segments.push({
        runId,
        runGroupId: event.runGroupId,
        events: [event],
        startGroupIndex: groupIndex,
        endGroupIndex: groupIndex + 1,
      });
    }
  }

  return segments;
}

function appendFoldsBeforeGroup(
  foldsByNextGroupId: Map<string, RunGroupFold[]>,
  nextGroupId: string,
  folds: readonly RunGroupFold[],
): void {
  if (folds.length === 0) {
    return;
  }
  const existing = foldsByNextGroupId.get(nextGroupId);
  if (existing === undefined) {
    foldsByNextGroupId.set(nextGroupId, [...folds]);
    return;
  }
  existing.push(...folds);
}

function appendFoldBeforeGroup(
  foldsByNextGroupId: Map<string, RunGroupFold[]>,
  nextGroupId: string,
  fold: RunGroupFold,
): void {
  appendFoldsBeforeGroup(foldsByNextGroupId, nextGroupId, [fold]);
}

function isGroupedRunSegment(
  segment: EventSegment | undefined,
): segment is GroupedRunSegment {
  return segment?.runId !== undefined && segment.runGroupId !== undefined;
}

function runGroupStreakEndIndex(
  segments: readonly EventSegment[],
  startIndex: number,
  runGroupId: string,
): number {
  let endIndex = startIndex + 1;
  while (
    endIndex < segments.length &&
    isGroupedRunSegment(segments[endIndex]) &&
    segments[endIndex].runGroupId === runGroupId
  ) {
    endIndex++;
  }
  return endIndex;
}

interface RunGroupVisualWindowItem {
  readonly startGroupIndex: number;
  readonly endGroupIndex: number;
}

function appendIndividualGroupWindowItems(
  items: RunGroupVisualWindowItem[],
  startGroupIndex: number,
  endGroupIndex: number,
  coveredGroupIndex: number,
): number {
  const start = Math.max(startGroupIndex, coveredGroupIndex);
  for (let groupIndex = start; groupIndex < endGroupIndex; groupIndex++) {
    items.push({
      startGroupIndex: groupIndex,
      endGroupIndex: groupIndex + 1,
    });
  }
  return Math.max(coveredGroupIndex, endGroupIndex);
}

function runGroupVisualWindowItems(
  groups: readonly ChatEventGroup[],
): RunGroupVisualWindowItem[] {
  const segments = eventSegmentsFromGroups(groups);
  const items: RunGroupVisualWindowItem[] = [];
  let coveredGroupIndex = 0;

  for (let index = 0; index < segments.length; ) {
    const segment = segments[index]!;
    if (segment.endGroupIndex <= coveredGroupIndex) {
      index++;
      continue;
    }

    if (coveredGroupIndex < segment.startGroupIndex) {
      coveredGroupIndex = appendIndividualGroupWindowItems(
        items,
        coveredGroupIndex,
        segment.startGroupIndex,
        coveredGroupIndex,
      );
    }

    if (isGroupedRunSegment(segment)) {
      const endIndex = runGroupStreakEndIndex(
        segments,
        index,
        segment.runGroupId,
      );
      if (endIndex - index >= 2) {
        const finalSegment = segments[endIndex - 1]!;
        const startGroupIndex = Math.max(
          segment.startGroupIndex,
          coveredGroupIndex,
        );
        if (startGroupIndex < finalSegment.endGroupIndex) {
          items.push({
            startGroupIndex,
            endGroupIndex: finalSegment.endGroupIndex,
          });
          coveredGroupIndex = finalSegment.endGroupIndex;
        }
        index = endIndex;
        continue;
      }
    }

    coveredGroupIndex = appendIndividualGroupWindowItems(
      items,
      segment.startGroupIndex,
      segment.endGroupIndex,
      coveredGroupIndex,
    );
    index++;
  }

  appendIndividualGroupWindowItems(
    items,
    coveredGroupIndex,
    groups.length,
    coveredGroupIndex,
  );
  return items;
}

function visualWindowItemIndexForGroupIndex(
  items: readonly RunGroupVisualWindowItem[],
  groupIndex: number,
): number {
  return items.findIndex((item) => {
    return (
      groupIndex >= item.startGroupIndex && groupIndex < item.endGroupIndex
    );
  });
}

function trailingRunGroupVisualWindowStartIndex(
  items: readonly RunGroupVisualWindowItem[],
  visibleItemCount: number,
): number {
  if (items.length === 0) {
    return 0;
  }
  const startItemIndex = Math.max(0, items.length - visibleItemCount);
  return items[startItemIndex]?.startGroupIndex ?? 0;
}

export function runGroupVisualWindowStartIndex(
  groups: readonly ChatEventGroup[],
  cursorGroupId: string | null,
  visibleItemCount: number,
): number {
  if (groups.length === 0) {
    return 0;
  }
  if (visibleItemCount <= 0) {
    return groups.length;
  }

  const items = runGroupVisualWindowItems(groups);
  if (cursorGroupId === null) {
    return trailingRunGroupVisualWindowStartIndex(items, visibleItemCount);
  }

  const cursorGroupIndex = groups.findIndex((group) => {
    return group.beginEventId === cursorGroupId;
  });
  if (cursorGroupIndex === -1) {
    return trailingRunGroupVisualWindowStartIndex(items, visibleItemCount);
  }

  const cursorItemIndex = visualWindowItemIndexForGroupIndex(
    items,
    cursorGroupIndex,
  );
  return cursorItemIndex === -1
    ? trailingRunGroupVisualWindowStartIndex(items, visibleItemCount)
    : (items[cursorItemIndex]?.startGroupIndex ?? 0);
}

export function previousRunGroupVisualWindowStartIndex(
  groups: readonly ChatEventGroup[],
  currentStartGroupIndex: number,
  visibleItemCount: number,
): number {
  if (groups.length === 0) {
    return 0;
  }
  if (visibleItemCount <= 0) {
    return currentStartGroupIndex;
  }

  const items = runGroupVisualWindowItems(groups);
  const currentItemIndex = visualWindowItemIndexForGroupIndex(
    items,
    currentStartGroupIndex,
  );
  const normalizedCurrentItemIndex =
    currentItemIndex === -1
      ? Math.max(0, items.length - visibleItemCount)
      : currentItemIndex;
  const previousItemIndex = Math.max(
    0,
    normalizedCurrentItemIndex - visibleItemCount,
  );
  return items[previousItemIndex]?.startGroupIndex ?? 0;
}

function buildFoldSection(
  runSegments: readonly GroupedRunSegment[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
  expansionOverrides: ReadonlyMap<string, boolean> | undefined,
  protectedEventId: string | null,
): {
  readonly fold: RunGroupFold;
  readonly expandedNextGroupId: string;
  readonly collapsedNextGroupId: string;
  readonly expandedGroups: ChatEventGroup[];
  readonly collapsedGroups: ChatEventGroup[];
} | null {
  const hiddenSegments = runSegments.slice(0, -1);
  const latestSegment = runSegments[runSegments.length - 1];
  if (latestSegment === undefined) {
    return null;
  }

  const hiddenGroups = hiddenSegments.flatMap((item) => {
    return segmentGroups(item, usageByRunId);
  });
  const collapsedUsageByRunId = new Map(usageByRunId);
  const collapsedUsage = mergedUsageForRunSegments(runSegments, usageByRunId);
  if (collapsedUsage !== undefined) {
    collapsedUsageByRunId.set(latestSegment.runId, collapsedUsage);
  }
  const collapsedGroups = segmentGroups(latestSegment, collapsedUsageByRunId);
  const expandedGroups = runSegments.flatMap((item) => {
    return segmentGroups(item, usageByRunId);
  });
  const firstHiddenRunId = hiddenSegments[0]?.runId;
  const collapsedNextGroupId = collapsedGroups[0]?.beginEventId;
  const expandedNextGroupId = hiddenGroups[0]?.beginEventId;

  if (
    firstHiddenRunId === undefined ||
    collapsedNextGroupId === undefined ||
    expandedNextGroupId === undefined
  ) {
    return null;
  }

  const key = `${latestSegment.runGroupId}:${firstHiddenRunId}:${latestSegment.runId}`;
  const containsProtectedEvent =
    protectedEventId !== null &&
    hiddenGroups.some((group) => {
      return group.events.some((event) => {
        return event.id === protectedEventId;
      });
    });

  return {
    fold: {
      key,
      runGroupId: latestSegment.runGroupId,
      hiddenRunCount: hiddenSegments.length,
      hiddenGroups,
      labelGroups: expandedGroups,
      expanded:
        containsProtectedEvent || (expansionOverrides?.get(key) ?? false),
    },
    expandedNextGroupId,
    collapsedNextGroupId,
    expandedGroups,
    collapsedGroups,
  };
}

export function buildRunGroupFolding(
  groups: readonly ChatEventGroup[],
  expansionOverrides?: ReadonlyMap<string, boolean>,
  protectedEventId: string | null = null,
): RunGroupFolding | null {
  const segments = eventSegmentsFromGroups(groups);
  const usageByRunId = usageByRunIdFromGroups(groups);
  const visibleGroups: ChatEventGroup[] = [];
  const foldsByNextGroupId = new Map<string, RunGroupFold[]>();

  for (let index = 0; index < segments.length; ) {
    const segment = segments[index]!;
    if (!isGroupedRunSegment(segment)) {
      visibleGroups.push(...segmentGroups(segment, usageByRunId));
      index++;
      continue;
    }

    const endIndex = runGroupStreakEndIndex(
      segments,
      index,
      segment.runGroupId,
    );
    const runCount = endIndex - index;
    if (runCount < 2) {
      visibleGroups.push(...segmentGroups(segment, usageByRunId));
      index = endIndex;
      continue;
    }

    const runSegments = segments
      .slice(index, endIndex)
      .filter(isGroupedRunSegment);
    const foldSection = buildFoldSection(
      runSegments,
      usageByRunId,
      expansionOverrides,
      protectedEventId,
    );
    if (foldSection === null) {
      visibleGroups.push(
        ...runSegments.flatMap((item) => {
          return segmentGroups(item, usageByRunId);
        }),
      );
      index = endIndex;
      continue;
    }

    if (foldSection.fold.expanded) {
      visibleGroups.push(...foldSection.expandedGroups);
      appendFoldBeforeGroup(
        foldsByNextGroupId,
        foldSection.expandedNextGroupId,
        foldSection.fold,
      );
    } else {
      visibleGroups.push(...foldSection.collapsedGroups);
      appendFoldBeforeGroup(
        foldsByNextGroupId,
        foldSection.collapsedNextGroupId,
        foldSection.fold,
      );
    }

    index = endIndex;
  }

  if (foldsByNextGroupId.size === 0) {
    return null;
  }

  return { visibleGroups, foldsByNextGroupId };
}
