import type { AutomationView } from "@vm0/api-contracts/contracts/automation-view";

// Shared in-memory store backing the automations mock handlers
// (`/api/automations`).
let mockAutomations: AutomationView[] = [];

export function getMockAutomations(): AutomationView[] {
  return mockAutomations;
}

export function setMockAutomations(automations: AutomationView[]): void {
  mockAutomations = automations;
}

export function resetMockAutomations(): void {
  mockAutomations = [];
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
