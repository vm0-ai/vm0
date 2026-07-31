import { screen, waitFor, within } from "@testing-library/react";
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

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function setupWorkflowQueuePage({
  onRecallEventAppend,
}: {
  onRecallEventAppend?: (body: {
    revokesEventId: string;
    clientEventId: string;
  }) => void;
} = {}): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Workflow queue thread",
    chatEvents: [
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
      {
        id: EVENT_ID_1,
        eventType: "input.automation",
        content: null,
        triggerSource: "workflow-event",
        userMessage: {
          version: 1,
          parts: [{ type: "automation", workflowName: "customer-followup" }],
        },
        runId: undefined,
        createdAt: "2026-07-10T01:01:00Z",
      },
      {
        id: EVENT_ID_2,
        eventType: "input.automation",
        content: null,
        triggerSource: "workflow-event",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "customer-followup",
              automationBrief: "Webhook event third",
            },
          ],
        },
        runId: undefined,
        createdAt: "2026-07-10T01:02:00Z",
      },
    ],
    activeRunIds: ["run-workflow-1"],
    onRecallEventAppend,
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
}

describe("workflow queue panel", () => {
  it("shows messages, automation events, and the active goal in one bottom queue", async () => {
    setupWorkflowQueuePage();

    await waitFor(() => {
      expect(
        screen.getByText("1 message and 2 events waiting"),
      ).toBeInTheDocument();
      expect(screen.getByText("Nightly sync")).toBeInTheDocument();
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
    expect(screen.getAllByLabelText("Queued message")).toHaveLength(1);
    expect(
      screen.queryByLabelText("Pause automation events"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Automation event queue actions"),
    ).not.toBeInTheDocument();
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
    let recall: { revokesEventId: string; clientEventId: string } | undefined;
    setupWorkflowQueuePage({
      onRecallEventAppend: (body) => {
        recall = body;
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Nightly sync")).toBeInTheDocument();
    });

    const skipButtons = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Skip automation event";
    });
    expect(skipButtons).toHaveLength(2);
    click(skipButtons[0]!);

    await waitFor(() => {
      expect(recall?.revokesEventId).toBe(EVENT_ID_1);
      expect(recall?.clientEventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(screen.queryByText("Nightly sync")).not.toBeInTheDocument();
      expect(screen.getByText("Webhook event third")).toBeInTheDocument();
    });
  });
});
