import type { ChatThreadWorkflowAutomation } from "@vm0/api-contracts/contracts/zero-workflows";

// Shared in-memory store backing workflow automation mock handlers.
let mockWorkflowAutomations: ChatThreadWorkflowAutomation[] = [];
type MockWorkflowAutomationOverrides = Partial<
  Omit<ChatThreadWorkflowAutomation, "workflow">
> & {
  readonly eventType?:
    | "gmail-new-message"
    | "gmail-label-applied"
    | "github-label-applied"
    | "github-deployment-status-created"
    | "github-issue-comment-created"
    | "github-pull-request-review-submitted"
    | "github-workflow-job-completed"
    | "github-workflow-run-completed"
    | "google-calendar-event-created"
    | "google-calendar-event-updated"
    | "google-calendar-event-cancelled"
    | "notion-child-page-created"
    | "notion-database-item-created";
  readonly eventConfig?: Extract<
    ChatThreadWorkflowAutomation,
    { kind: "event" }
  >["eventConfig"];
  readonly workflow?: Partial<ChatThreadWorkflowAutomation["workflow"]>;
};

export function getMockWorkflowAutomations(): ChatThreadWorkflowAutomation[] {
  return mockWorkflowAutomations;
}

export function setMockWorkflowAutomations(
  automations: ChatThreadWorkflowAutomation[],
): void {
  mockWorkflowAutomations = automations;
}

export function resetMockWorkflowAutomations(): void {
  mockWorkflowAutomations = [];
}

type MockWorkflowAutomationBase = {
  readonly id: string;
  readonly enabled: boolean;
  readonly chatThreadId: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly ownerUserId: string;
  readonly workflow: ChatThreadWorkflowAutomation["workflow"];
};

function createMockNotionChildPageAutomation(
  base: MockWorkflowAutomationBase,
  overrides: MockWorkflowAutomationOverrides,
  workflow: ChatThreadWorkflowAutomation["workflow"],
): ChatThreadWorkflowAutomation {
  return {
    ...base,
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      parentPage: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Roadmap",
        url: "https://www.notion.so/Roadmap-11111111111141118111111111111111",
      },
    },
    schedule: null,
    scheduleSummary: null,
    ...overrides,
    workflow,
  } as ChatThreadWorkflowAutomation;
}

function createMockNotionDatabaseItemAutomation(
  base: MockWorkflowAutomationBase,
  overrides: MockWorkflowAutomationOverrides,
  workflow: ChatThreadWorkflowAutomation["workflow"],
): ChatThreadWorkflowAutomation {
  return {
    ...base,
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      dataSource: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Bug Bash",
        url: "https://www.notion.so/Bug-Bash-22222222222242228222222222222222",
      },
    },
    schedule: null,
    scheduleSummary: null,
    ...overrides,
    workflow,
  } as ChatThreadWorkflowAutomation;
}

function createMockGmailLabelAutomation(
  base: MockWorkflowAutomationBase,
  overrides: MockWorkflowAutomationOverrides,
  workflow: ChatThreadWorkflowAutomation["workflow"],
): ChatThreadWorkflowAutomation {
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
  } as ChatThreadWorkflowAutomation;
}

function createMockGithubLabelAutomation(
  base: MockWorkflowAutomationBase,
  overrides: MockWorkflowAutomationOverrides,
  workflow: ChatThreadWorkflowAutomation["workflow"],
): ChatThreadWorkflowAutomation {
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
  } as ChatThreadWorkflowAutomation;
}

function createMockGithubWorkflowRunAutomation(
  base: MockWorkflowAutomationBase,
  overrides: MockWorkflowAutomationOverrides,
  workflow: ChatThreadWorkflowAutomation["workflow"],
): ChatThreadWorkflowAutomation {
  return {
    ...base,
    kind: "event",
    eventType: "github-workflow-run-completed",
    eventConfig: {
      provider: "github",
      event: "workflow_run_completed",
      filters: {},
    },
    schedule: null,
    scheduleSummary: null,
    ...overrides,
    workflow,
  } as ChatThreadWorkflowAutomation;
}

function createMockGithubWebhookAutomation(
  base: MockWorkflowAutomationBase,
  overrides: MockWorkflowAutomationOverrides,
  workflow: ChatThreadWorkflowAutomation["workflow"],
): ChatThreadWorkflowAutomation {
  const eventType = overrides.eventType ?? "github-workflow-job-completed";
  const eventConfig =
    eventType === "github-pull-request-review-submitted"
      ? {
          provider: "github",
          event: "pull_request_review_submitted",
          filters: {},
        }
      : eventType === "github-deployment-status-created"
        ? {
            provider: "github",
            event: "deployment_status_created",
            filters: {},
          }
        : eventType === "github-issue-comment-created"
          ? {
              provider: "github",
              event: "issue_comment_created",
              filters: { subject: "both" },
            }
          : {
              provider: "github",
              event: "workflow_job_completed",
              filters: {},
            };
  return {
    ...base,
    kind: "event",
    eventType,
    eventConfig,
    schedule: null,
    scheduleSummary: null,
    ...overrides,
    workflow,
  } as ChatThreadWorkflowAutomation;
}

function createMockGoogleCalendarAutomation(
  base: MockWorkflowAutomationBase,
  overrides: MockWorkflowAutomationOverrides,
  workflow: ChatThreadWorkflowAutomation["workflow"],
): ChatThreadWorkflowAutomation {
  return {
    ...base,
    kind: "event",
    eventType: overrides.eventType ?? "google-calendar-event-created",
    eventConfig: {
      provider: "google-calendar",
      event:
        overrides.eventType === "google-calendar-event-updated"
          ? "event_updated"
          : overrides.eventType === "google-calendar-event-cancelled"
            ? "event_cancelled"
            : "event_created",
      calendarId: "primary",
    },
    schedule: null,
    scheduleSummary: null,
    ...overrides,
    workflow,
  } as ChatThreadWorkflowAutomation;
}

/** A workflow-automation store row with sensible defaults. */
export function createMockWorkflowAutomation(
  overrides?: MockWorkflowAutomationOverrides,
): ChatThreadWorkflowAutomation {
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
      return createMockGmailLabelAutomation(base, overrides, workflow);
    }
    if (overrides.eventType === "github-label-applied") {
      return createMockGithubLabelAutomation(base, overrides, workflow);
    }
    if (overrides.eventType === "github-workflow-run-completed") {
      return createMockGithubWorkflowRunAutomation(base, overrides, workflow);
    }
    if (
      overrides.eventType === "github-workflow-job-completed" ||
      overrides.eventType === "github-pull-request-review-submitted" ||
      overrides.eventType === "github-deployment-status-created" ||
      overrides.eventType === "github-issue-comment-created"
    ) {
      return createMockGithubWebhookAutomation(base, overrides, workflow);
    }
    if (overrides.eventType?.startsWith("google-calendar-event-")) {
      return createMockGoogleCalendarAutomation(base, overrides, workflow);
    }
    if (overrides.eventType === "notion-child-page-created") {
      return createMockNotionChildPageAutomation(base, overrides, workflow);
    }
    if (overrides.eventType === "notion-database-item-created") {
      return createMockNotionDatabaseItemAutomation(base, overrides, workflow);
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
    } as ChatThreadWorkflowAutomation;
  }
  return {
    ...base,
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 60 },
    scheduleSummary: "Every 60s",
    ...overrides,
    workflow,
  } as ChatThreadWorkflowAutomation;
}

const DEFAULT_CHAT_THREAD_ID = "d0000000-0000-4000-a000-000000000001";
