import { screen, waitFor, within } from "@testing-library/react";
import {
  zeroWorkflowQueueContract,
  type WorkflowQueueResponse,
} from "@vm0/api-contracts/contracts/zero-workflow-queue";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  createMockWorkflowAutomation,
  setMockWorkflowAutomations,
} from "../../../mocks/handlers/workflow-automations-store.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "d0000000-0000-4000-a000-0000000000aa";
const EVENT_ID_1 = "f0000001-0000-4000-a000-000000000001";
const EVENT_ID_2 = "f0000002-0000-4000-a000-000000000002";

function queueResponse(
  overrides?: Partial<WorkflowQueueResponse>,
): WorkflowQueueResponse {
  return {
    running: {
      runId: "run-workflow-1",
      status: "running",
      triggerBrief: "Webhook event busy",
      createdAt: "2026-07-10T01:00:00Z",
    },
    pending: [
      {
        id: EVENT_ID_1,
        automationId: "e0000001-0000-4000-a000-000000000001",
        triggerSource: "workflow-event",
        triggerBrief: "Webhook event second",
        createdAt: "2026-07-10T01:01:00Z",
      },
      {
        id: EVENT_ID_2,
        automationId: "e0000001-0000-4000-a000-000000000001",
        triggerSource: "workflow-event",
        triggerBrief: "Webhook event third",
        createdAt: "2026-07-10T01:02:00Z",
      },
    ],
    pausedAt: null,
    pauseReason: null,
    ...overrides,
  };
}

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

async function setupWorkflowQueuePage({
  openSidebar = false,
}: {
  openSidebar?: boolean;
} = {}): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Workflow queue thread",
    chatMessages: [
      {
        id: "msg-workflow-running-user",
        role: "user",
        content: "Automation run",
        runId: "run-workflow-1",
        createdAt: "2026-07-10T00:59:00Z",
      },
      {
        id: "msg-workflow-running-assistant",
        role: "assistant",
        content: null,
        runId: "run-workflow-1",
        createdAt: "2026-07-10T00:59:01Z",
      },
      {
        id: "msg-queued-user",
        role: "user",
        content: "Review the queued customer reply",
        runId: undefined,
        createdAt: "2026-07-10T01:00:00Z",
      },
      {
        id: "msg-active-goal",
        role: "assistant",
        content: null,
        runId: undefined,
        goalEvent: {
          type: "state",
          status: "active",
          objectiveBrief: "Keep customer follow-ups under four hours",
        },
        createdAt: "2026-07-10T01:00:01Z",
      },
    ],
    activeRunIds: ["run-workflow-1"],
  });
  setMockWorkflowAutomations([
    createMockWorkflowAutomation({
      chatThreadId: THREAD_ID,
      kind: "event",
      eventType: "gmail-new-message",
    }),
  ]);

  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  if (!openSidebar) {
    return;
  }
  await waitFor(() => {
    expect(buttonByLabel("Automations")).toBeInTheDocument();
  });
  click(buttonByLabel("Automations"));
  await waitFor(() => {
    expect(screen.getByTestId("automation-sidebar")).toBeInTheDocument();
  });
}

describe("workflow queue panel", () => {
  it("shows messages, automation events, and the active goal in one bottom queue", async () => {
    context.mocks.api(zeroWorkflowQueueContract.get, ({ respond }) => {
      return respond(200, queueResponse());
    });

    await setupWorkflowQueuePage();

    await waitFor(() => {
      expect(screen.getByText("4 items waiting")).toBeInTheDocument();
      expect(screen.getByText("Messages run first")).toBeInTheDocument();
      expect(screen.getByText("Webhook event second")).toBeInTheDocument();
      expect(screen.getByText("Webhook event third")).toBeInTheDocument();
    });

    const goalRow = screen.getByLabelText("Active goal");
    const list = goalRow.closest('[role="list"]');
    expect(list).not.toBeNull();
    const rows = within(list as HTMLElement).getAllByRole("listitem");
    expect(
      rows.map((row) => {
        return row.getAttribute("aria-label");
      }),
    ).toStrictEqual([
      "Queued message",
      "Pending automation event",
      "Pending automation event",
      "Active goal",
    ]);
    expect(
      screen.queryByTestId("workflow-queue-badge"),
    ).not.toBeInTheDocument();

    click(buttonByLabel("Automations"));
    const sidebar = await screen.findByTestId("automation-sidebar");
    expect(
      within(sidebar).queryByTestId("workflow-queue-section"),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar).queryByText("Webhook event busy"),
    ).not.toBeInTheDocument();
  });

  it("skips a single pending event", async () => {
    let skippedEventId: string | null = null;
    let pending = queueResponse().pending;
    context.mocks.api(zeroWorkflowQueueContract.get, ({ respond }) => {
      return respond(200, queueResponse({ pending }));
    });
    context.mocks.api(
      zeroWorkflowQueueContract.skipEvent,
      ({ params, respond }) => {
        skippedEventId = params.id;
        pending = pending.filter((event) => {
          return event.id !== params.id;
        });
        return respond(200, queueResponse({ pending }));
      },
    );

    await setupWorkflowQueuePage();
    await waitFor(() => {
      expect(screen.getByText("Webhook event second")).toBeInTheDocument();
    });

    const skipButtons = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Skip automation event";
    });
    expect(skipButtons).toHaveLength(2);
    click(skipButtons[0]!);

    await waitFor(() => {
      expect(skippedEventId).toBe(EVENT_ID_1);
      expect(
        screen.queryByText("Webhook event second"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Webhook event third")).toBeInTheDocument();
    });
  });

  it("pauses the queue and shows the paused banner", async () => {
    let paused = false;
    context.mocks.api(zeroWorkflowQueueContract.get, ({ respond }) => {
      return respond(
        200,
        queueResponse(
          paused ? { pausedAt: "2026-07-10T01:03:00Z", pauseReason: null } : {},
        ),
      );
    });
    context.mocks.api(zeroWorkflowQueueContract.pause, ({ respond }) => {
      paused = true;
      return respond(
        200,
        queueResponse({ pausedAt: "2026-07-10T01:03:00Z", pauseReason: null }),
      );
    });

    await setupWorkflowQueuePage();
    await waitFor(() => {
      expect(buttonByLabel("Pause automation events")).toBeInTheDocument();
    });
    click(buttonByLabel("Pause automation events"));

    await waitFor(() => {
      expect(screen.getByText(/Automation events paused/)).toBeInTheDocument();
      expect(buttonByLabel("Resume automation events")).toBeInTheDocument();
    });
  });
});
