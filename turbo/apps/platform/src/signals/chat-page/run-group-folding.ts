import { command, computed, state } from "ccstate";
import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
} from "./chat-message.ts";
import type { ChatMessageUsagePayload } from "@vm0/api-contracts/contracts/chat-threads";

interface RunSegment {
  readonly runId: string;
  runGroupId: string | undefined;
  readonly messages: EnrichedChatMessage[];
}

interface LooseSegment {
  readonly runId: undefined;
  readonly runGroupId: undefined;
  readonly messages: EnrichedChatMessage[];
}

type MessageSegment = RunSegment | LooseSegment;

type GroupedRunSegment = RunSegment & { runGroupId: string };

export interface RunGroupFold {
  readonly key: string;
  readonly runGroupId: string;
  readonly hiddenRunCount: number;
  readonly hiddenGroups: GroupedChatMessageGroup[];
  readonly labelGroups: GroupedChatMessageGroup[];
}

export interface RunGroupFolding {
  readonly visibleGroups: GroupedChatMessageGroup[];
  readonly foldsByNextGroupId: ReadonlyMap<string, readonly RunGroupFold[]>;
}

const internalRunGroupExpandedKeys$ = state<Set<string>>(new Set());

export const runGroupExpandedKeys$ = computed((get): Set<string> => {
  return get(internalRunGroupExpandedKeys$);
});

export const toggleRunGroupExpanded$ = command(({ set }, key: string) => {
  set(internalRunGroupExpandedKeys$, (prev) => {
    const next = new Set(prev);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
});

function groupMessagesByRole(
  messages: readonly EnrichedChatMessage[],
): GroupedChatMessageGroup[] {
  const groups: GroupedChatMessageGroup[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && last.role === message.role) {
      last.messages.push(message);
      continue;
    }
    groups.push({
      beginMessageId: message.id,
      role: message.role,
      messages: [message],
    });
  }
  return groups;
}

function firstRunIdForMessages(
  messages: readonly EnrichedChatMessage[],
): string | undefined {
  return messages.find((message) => {
    return message.runId !== undefined;
  })?.runId;
}

function usageByRunIdFromGroups(
  groups: readonly GroupedChatMessageGroup[],
): Map<string, ChatMessageUsagePayload> {
  const usageByRunId = new Map<string, ChatMessageUsagePayload>();
  for (const group of groups) {
    if (group.role !== "assistant" || group.usage === undefined) {
      continue;
    }
    const runId = firstRunIdForMessages(group.messages);
    if (runId !== undefined) {
      usageByRunId.set(runId, group.usage);
    }
  }
  return usageByRunId;
}

function attachUsageToGroups(
  groups: readonly GroupedChatMessageGroup[],
  usageByRunId: ReadonlyMap<string, ChatMessageUsagePayload>,
): GroupedChatMessageGroup[] {
  return groups.map((group) => {
    if (group.role !== "assistant") {
      return group;
    }
    const runId = firstRunIdForMessages(group.messages);
    const usage = runId === undefined ? undefined : usageByRunId.get(runId);
    return usage === undefined ? group : { ...group, usage };
  });
}

function segmentGroups(
  segment: MessageSegment,
  usageByRunId: ReadonlyMap<string, ChatMessageUsagePayload>,
): GroupedChatMessageGroup[] {
  return attachUsageToGroups(
    groupMessagesByRole(segment.messages),
    usageByRunId,
  );
}

function messageSegmentsFromGroups(
  groups: readonly GroupedChatMessageGroup[],
): MessageSegment[] {
  const segments: MessageSegment[] = [];

  for (const group of groups) {
    for (const message of group.messages) {
      const runId = message.runId;
      if (runId === undefined) {
        segments.push({
          runId: undefined,
          runGroupId: undefined,
          messages: [message],
        });
        continue;
      }

      const last = segments[segments.length - 1];
      if (last?.runId === runId) {
        last.messages.push(message);
        if (last.runGroupId === undefined) {
          last.runGroupId = message.runGroupId;
        }
        continue;
      }

      segments.push({
        runId,
        runGroupId: message.runGroupId,
        messages: [message],
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
  segment: MessageSegment | undefined,
): segment is GroupedRunSegment {
  return segment?.runId !== undefined && segment.runGroupId !== undefined;
}

function runGroupStreakEndIndex(
  segments: readonly MessageSegment[],
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

function buildFoldSection(
  runSegments: readonly GroupedRunSegment[],
  usageByRunId: ReadonlyMap<string, ChatMessageUsagePayload>,
): {
  readonly fold: RunGroupFold;
  readonly expandedNextGroupId: string;
  readonly collapsedNextGroupId: string;
  readonly expandedGroups: GroupedChatMessageGroup[];
  readonly collapsedGroups: GroupedChatMessageGroup[];
} | null {
  const hiddenSegments = runSegments.slice(0, -1);
  const latestSegment = runSegments[runSegments.length - 1];
  if (latestSegment === undefined) {
    return null;
  }

  const hiddenGroups = hiddenSegments.flatMap((item) => {
    return segmentGroups(item, usageByRunId);
  });
  const collapsedGroups = segmentGroups(latestSegment, usageByRunId);
  const expandedGroups = runSegments.flatMap((item) => {
    return segmentGroups(item, usageByRunId);
  });
  const firstHiddenRunId = hiddenSegments[0]?.runId;
  const collapsedNextGroupId = collapsedGroups[0]?.beginMessageId;
  const expandedNextGroupId = hiddenGroups[0]?.beginMessageId;

  if (
    firstHiddenRunId === undefined ||
    collapsedNextGroupId === undefined ||
    expandedNextGroupId === undefined
  ) {
    return null;
  }

  return {
    fold: {
      key: `${latestSegment.runGroupId}:${firstHiddenRunId}:${latestSegment.runId}`,
      runGroupId: latestSegment.runGroupId,
      hiddenRunCount: hiddenSegments.length,
      hiddenGroups,
      labelGroups: expandedGroups,
    },
    expandedNextGroupId,
    collapsedNextGroupId,
    expandedGroups,
    collapsedGroups,
  };
}

export function buildRunGroupFolding(
  groups: readonly GroupedChatMessageGroup[],
  expandedKeys?: ReadonlySet<string>,
): RunGroupFolding | null {
  const segments = messageSegmentsFromGroups(groups);
  const usageByRunId = usageByRunIdFromGroups(groups);
  const visibleGroups: GroupedChatMessageGroup[] = [];
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
    const foldSection = buildFoldSection(runSegments, usageByRunId);
    if (foldSection === null) {
      visibleGroups.push(
        ...runSegments.flatMap((item) => {
          return segmentGroups(item, usageByRunId);
        }),
      );
      index = endIndex;
      continue;
    }

    const expanded = expandedKeys?.has(foldSection.fold.key) ?? false;

    if (expanded) {
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
