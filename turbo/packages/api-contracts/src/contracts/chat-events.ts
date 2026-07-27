import { z } from "zod";
import type { ZeroGoalEvent } from "./zero-goals";

export const CHAT_EVENT_TYPES = [
  "input.prompt",
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
export type ChatEventCompatibilityRole = "user" | "assistant";
export type ChatEventRunLifecycle = "completed" | "failed" | "cancelled";
export type ChatRunFoldState = "queued" | "dequeued" | ChatEventRunLifecycle;

interface ChatEventFoldInput {
  readonly eventType: ChatEventType;
  readonly runId?: string;
  readonly interruptsRunId?: string;
  readonly revokesEventId?: string;
  readonly goalEvent?: ZeroGoalEvent;
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
  switch (sourceType) {
    case "input.prompt":
      return targetType === "input.prompt" || targetType === "output.followups";
    case "input.rejected":
      return targetType === "input.prompt" || targetType === "output.followups";
    case "control.revoke":
      return targetType === "input.prompt" || targetType === "input.rejected";
    case "run.dequeued":
      return targetType === "run.queued";
    case "output.message":
    case "output.error":
    case "output.thinking":
    case "output.followups":
    case "run.queued":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "control.interrupt":
    case "goal.changed":
    case "usage.recorded":
      return false;
  }
}

export function revokedChatEventIds(
  events: readonly ChatEventFoldInput[],
): Set<string> {
  return new Set(
    events.flatMap((event) => {
      return event.revokesEventId === undefined ? [] : [event.revokesEventId];
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
    if (event.runId === undefined) {
      continue;
    }
    switch (event.eventType) {
      case "run.queued":
        states.set(event.runId, "queued");
        break;
      case "run.dequeued":
        states.set(event.runId, "dequeued");
        break;
      case "run.completed":
        states.set(event.runId, "completed");
        break;
      case "run.failed":
        states.set(event.runId, "failed");
        break;
      case "run.cancelled":
        states.set(event.runId, "cancelled");
        break;
      case "input.prompt":
      case "input.rejected":
      case "output.message":
      case "output.error":
      case "output.thinking":
      case "output.followups":
      case "control.interrupt":
      case "control.revoke":
      case "goal.changed":
      case "usage.recorded":
        break;
    }
  }
  return states;
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
