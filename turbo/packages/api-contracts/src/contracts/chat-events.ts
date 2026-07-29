import { z } from "zod";
import type { ZeroGoalEvent } from "./zero-goals";

export const CHAT_EVENT_TYPES = [
  "input.prompt",
  "input.automation",
  "input.goal",
  "input.rejected",
  "output.message",
  "output.error",
  "output.thinking",
  "output.followups",
  "run.queued",
  "run.dequeued",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "control.interrupt",
  "control.revoke",
  "goal.changed",
  "usage.recorded",
] as const;

export const chatEventTypeSchema = z.enum(CHAT_EVENT_TYPES);

export type ChatEventType = z.infer<typeof chatEventTypeSchema>;
type MaterializedChatEventType = Exclude<ChatEventType, "input.goal">;
export const MATERIALIZED_CHAT_EVENT_TYPES = CHAT_EVENT_TYPES.filter(
  (eventType): eventType is MaterializedChatEventType => {
    return eventType !== "input.goal";
  },
);
export type ChatEventCompatibilityRole = "user" | "assistant";
export type ChatEventRunLifecycle = "completed" | "failed" | "cancelled";
export type ChatRunFoldState = "queued" | "dequeued" | ChatEventRunLifecycle;

const VALID_CHAT_EVENT_REVOCATION_TARGETS = {
  "input.prompt": [
    "input.prompt",
    "input.automation",
    "input.goal",
    "output.followups",
  ],
  "input.automation": [],
  "input.goal": [],
  "input.rejected": [
    "input.prompt",
    "input.automation",
    "input.goal",
    "output.followups",
  ],
  "output.message": [],
  "output.error": [],
  "output.thinking": [],
  "output.followups": [],
  "run.queued": [],
  "run.dequeued": ["run.queued"],
  "run.completed": [],
  "run.failed": [],
  "run.cancelled": [],
  "control.interrupt": [],
  "control.revoke": [
    "input.prompt",
    "input.automation",
    "input.goal",
    "input.rejected",
  ],
  "goal.changed": [],
  "usage.recorded": [],
} satisfies Record<ChatEventType, readonly ChatEventType[]>;

const CHAT_RUN_FOLD_STATES = {
  "input.prompt": null,
  "input.automation": null,
  "input.goal": null,
  "input.rejected": null,
  "output.message": null,
  "output.error": null,
  "output.thinking": null,
  "output.followups": null,
  "run.queued": "queued",
  "run.dequeued": "dequeued",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "control.interrupt": null,
  "control.revoke": null,
  "goal.changed": null,
  "usage.recorded": null,
} satisfies Record<ChatEventType, ChatRunFoldState | null>;

interface ChatEventFoldInput {
  readonly id?: string;
  readonly eventType: ChatEventType;
  readonly runId?: string | null;
  readonly interruptsRunId?: string;
  readonly revokesEventId?: string | null;
  readonly goalEvent?: ZeroGoalEvent;
}

export interface ChatQueueFoldInput extends ChatEventFoldInput {
  readonly id: string;
  readonly createdAt: string;
}

interface ChatUsageFoldInput extends ChatEventFoldInput {
  readonly usage?: {
    readonly settledAt: string;
  };
}

export function chatEventCompatibilityRole(
  eventType: ChatEventType,
): ChatEventCompatibilityRole {
  switch (eventType) {
    case "input.prompt":
    case "input.automation":
    case "input.goal":
    case "input.rejected":
    case "control.interrupt":
    case "control.revoke":
      return "user";
    case "output.message":
    case "output.error":
    case "output.thinking":
    case "output.followups":
    case "run.queued":
    case "run.dequeued":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "goal.changed":
    case "usage.recorded":
      return "assistant";
  }
}

export function chatEventRunLifecycle(
  eventType: ChatEventType,
): ChatEventRunLifecycle | null {
  switch (eventType) {
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    case "input.prompt":
    case "input.automation":
    case "input.goal":
    case "input.rejected":
    case "output.message":
    case "output.error":
    case "output.thinking":
    case "output.followups":
    case "run.queued":
    case "run.dequeued":
    case "control.interrupt":
    case "control.revoke":
    case "goal.changed":
    case "usage.recorded":
      return null;
  }
}

export function isChatRunTerminalEventType(
  eventType: ChatEventType,
): eventType is "run.completed" | "run.failed" | "run.cancelled" {
  return (
    eventType === "run.completed" ||
    eventType === "run.failed" ||
    eventType === "run.cancelled"
  );
}

export function isChatInputEventType(
  eventType: ChatEventType,
): eventType is
  | "input.prompt"
  | "input.automation"
  | "input.goal"
  | "input.rejected" {
  return (
    eventType === "input.prompt" ||
    eventType === "input.automation" ||
    eventType === "input.goal" ||
    eventType === "input.rejected"
  );
}

export function isChatUserMessageEventType(
  eventType: ChatEventType,
): eventType is "input.prompt" | "input.rejected" {
  return eventType === "input.prompt" || eventType === "input.rejected";
}

export function isChatOutputEventType(
  eventType: ChatEventType,
): eventType is
  | "output.message"
  | "output.error"
  | "output.thinking"
  | "output.followups" {
  return eventType.startsWith("output.");
}

export function isValidChatEventRevocation(
  sourceType: ChatEventType,
  targetType: ChatEventType,
): boolean {
  const targets: readonly ChatEventType[] =
    VALID_CHAT_EVENT_REVOCATION_TARGETS[sourceType];
  return targets.includes(targetType);
}

export function revokedChatEventIds(
  events: readonly ChatEventFoldInput[],
): Set<string> {
  return new Set(
    events.flatMap((event) => {
      return event.revokesEventId === undefined || event.revokesEventId === null
        ? []
        : [event.revokesEventId];
    }),
  );
}

export function terminatedChatRunIds(
  events: readonly ChatEventFoldInput[],
): Set<string> {
  const runIds = new Set<string>();
  for (const event of events) {
    if (event.eventType === "control.interrupt") {
      if (event.interruptsRunId !== undefined) {
        runIds.add(event.interruptsRunId);
      }
      continue;
    }
    if (
      event.runId !== undefined &&
      event.runId !== null &&
      isChatRunTerminalEventType(event.eventType)
    ) {
      runIds.add(event.runId);
    }
  }
  return runIds;
}

export function foldChatRunStates(
  events: readonly ChatEventFoldInput[],
): Map<string, ChatRunFoldState> {
  const states = new Map<string, ChatRunFoldState>();
  for (const event of events) {
    if (event.runId === undefined || event.runId === null) {
      continue;
    }
    const state = CHAT_RUN_FOLD_STATES[event.eventType];
    if (state !== null) {
      states.set(event.runId, state);
    }
  }
  return states;
}

export function isPendingChatQueueEvent(
  event: ChatQueueFoldInput,
  revokedEventIds: ReadonlySet<string>,
): boolean {
  return (
    (event.eventType === "input.prompt" ||
      event.eventType === "input.automation" ||
      event.eventType === "input.goal") &&
    (event.runId === undefined || event.runId === null) &&
    !revokedEventIds.has(event.id)
  );
}

function compareChatQueueEvents(
  left: ChatQueueFoldInput,
  right: ChatQueueFoldInput,
): number {
  const priority = (eventType: ChatEventType): number => {
    if (eventType === "input.prompt") {
      return 0;
    }
    if (eventType === "input.automation") {
      return 1;
    }
    return 2;
  };
  const leftPriority = priority(left.eventType);
  const rightPriority = priority(right.eventType);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

export function foldPendingChatQueueEvents<TEvent extends ChatQueueFoldInput>(
  events: readonly TEvent[],
): TEvent[] {
  const revokedEventIds = revokedChatEventIds(events);
  return events
    .filter((event) => {
      return isPendingChatQueueEvent(event, revokedEventIds);
    })
    .sort(compareChatQueueEvents);
}

export function foldRunnableChatQueueEvents<TEvent extends ChatQueueFoldInput>(
  events: readonly TEvent[],
): TEvent[] {
  return foldPendingChatQueueEvents(events);
}

export function foldActiveChatGoalObjective(
  events: readonly ChatEventFoldInput[],
): string | null {
  let objective: string | null = null;
  for (const event of events) {
    if (event.eventType !== "goal.changed" || event.goalEvent === undefined) {
      continue;
    }
    if (event.goalEvent.type === "cleared") {
      objective = null;
    } else if (event.goalEvent.status === "active") {
      objective = event.goalEvent.objectiveBrief;
    } else {
      objective = null;
    }
  }
  const trimmed = objective?.trim();
  return trimmed || null;
}

export function foldLatestChatUsageByRunId<
  TUsage extends { readonly settledAt: string },
>(
  events: readonly (ChatUsageFoldInput & { readonly usage?: TUsage })[],
): Map<string, TUsage> {
  const usageByRunId = new Map<string, TUsage>();
  for (const event of events) {
    if (
      event.eventType !== "usage.recorded" ||
      event.runId === undefined ||
      event.runId === null ||
      event.usage === undefined
    ) {
      continue;
    }
    const existing = usageByRunId.get(event.runId);
    if (
      existing === undefined ||
      chatUsageSettledAtMs(event.usage) >= chatUsageSettledAtMs(existing)
    ) {
      usageByRunId.set(event.runId, event.usage);
    }
  }
  return usageByRunId;
}

function chatUsageSettledAtMs(usage: { readonly settledAt: string }): number {
  const timestamp = Date.parse(usage.settledAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
