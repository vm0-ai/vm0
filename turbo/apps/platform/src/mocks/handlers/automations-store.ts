import type { ChatThreadWorkflowTrigger } from "@vm0/api-contracts/contracts/zero-workflows";
import type { AutomationView } from "@vm0/api-contracts/contracts/automation-view";

// Shared in-memory store backing the automations mock handlers
// (`/api/automations`).
let mockAutomations: AutomationView[] = [];
let mockWorkflowTriggers: ChatThreadWorkflowTrigger[] = [];
type MockWorkflowTriggerOverrides = Partial<
  Omit<ChatThreadWorkflowTrigger, "workflow">
> & {
  readonly eventType?:
    | "gmail-new-message"
    | "gmail-label-applied"
    | "github-label-applied"
    | "google-calendar-event-created"
    | "google-calendar-event-updated";
  readonly eventConfig?: Extract<
    ChatThreadWorkflowTrigger,
    { kind: "event" }
  >["eventConfig"];
  readonly workflow?: Partial<ChatThreadWorkflowTrigger["workflow"]>;
};

export function getMockAutomations(): AutomationView[] {
  return mockAutomations;
}

export function setMockAutomations(automations: AutomationView[]): void {
  mockAutomations = automations;
}

export function getMockWorkflowTriggers(): ChatThreadWorkflowTrigger[] {
  return mockWorkflowTriggers;
}

export function setMockWorkflowTriggers(
  triggers: ChatThreadWorkflowTrigger[],
): void {
  mockWorkflowTriggers = triggers;
}

export function resetMockAutomations(): void {
  mockAutomations = [];
  mockWorkflowTriggers = [];
}

/** A workflow-trigger store row with sensible defaults. */
export function createMockWorkflowTrigger(
  overrides?: MockWorkflowTriggerOverrides,
): ChatThreadWorkflowTrigger {
  const workflow = {
    id: "a0000001-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000001",
    name: "nightly-sync",
    displayName: "Nightly sync",
    description: "Sync the changelog every night",
    ...overrides?.workflow,
  };
  const base = {
    id: "e0000001-0000-4000-a000-000000000001",
    enabled: true,
    chatThreadId: DEFAULT_CHAT_THREAD_ID,
    nextRunAt: null,
    lastRunAt: null,
    ownerUserId: "test-user-123",
    workflow,
  };
  if (overrides?.kind === "event") {
    if (overrides.eventType === "gmail-label-applied") {
      return {
        ...base,
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Support",
        },
        schedule: null,
        scheduleSummary: null,
        ...overrides,
        workflow,
      } as ChatThreadWorkflowTrigger;
    }
    if (overrides.eventType === "github-label-applied") {
      return {
        ...base,
        kind: "event",
        eventType: "github-label-applied",
        eventConfig: {
          provider: "github",
          event: "label_applied",
          labelName: "triage",
          filters: {
            subject: "both",
            actor: { type: "me" },
          },
        },
        schedule: null,
        scheduleSummary: null,
        ...overrides,
        workflow,
      } as ChatThreadWorkflowTrigger;
    }
    if (overrides.eventType === "google-calendar-event-created") {
      return {
        ...base,
        kind: "event",
        eventType: "google-calendar-event-created",
        eventConfig: {
          provider: "google-calendar",
          event: "event_created",
          calendarId: "primary",
        },
        schedule: null,
        scheduleSummary: null,
        ...overrides,
        workflow,
      } as ChatThreadWorkflowTrigger;
    }
    if (overrides.eventType === "google-calendar-event-updated") {
      return {
        ...base,
        kind: "event",
        eventType: "google-calendar-event-updated",
        eventConfig: {
          provider: "google-calendar",
          event: "event_updated",
          calendarId: "primary",
        },
        schedule: null,
        scheduleSummary: null,
        ...overrides,
        workflow,
      } as ChatThreadWorkflowTrigger;
    }
    return {
      ...base,
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: { provider: "gmail", event: "new_message" },
      schedule: null,
      scheduleSummary: null,
      ...overrides,
      workflow,
    } as ChatThreadWorkflowTrigger;
  }
  return {
    ...base,
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 60 },
    scheduleSummary: "Every 60s",
    ...overrides,
    workflow,
  } as ChatThreadWorkflowTrigger;
}

const DEFAULT_CHAT_THREAD_ID = "d0000000-0000-4000-a000-000000000001";

/** A store row (flat single-trigger projection) with sensible defaults. */
export function createMockAutomationView(
  overrides?: Partial<AutomationView>,
): AutomationView {
  return {
    id: "f0000001-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: null,
    userId: "test-user-123",
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Summarize yesterday's threads",
    description: null,
    appendSystemPrompt: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    chatThreadId: DEFAULT_CHAT_THREAD_ID,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}
