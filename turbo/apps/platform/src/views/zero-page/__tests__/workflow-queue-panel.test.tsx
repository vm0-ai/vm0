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
const SOURCE_EVENT_ID = "f0000003-0000-4000-a000-000000000003";
const SOURCE_RUN_ID = "e0000001-0000-4000-a000-000000000001";
const SOURCE_THREAD_ID = "e0000002-0000-4000-a000-000000000002";
const SOURCE_AGENT_ID = "e0000003-0000-4000-a000-000000000003";
const SOURCE_EVENT_TEXT = "A run in the watched chat thread completed.";

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

/**
 * A chat-run-finished automation replaces its workflow annotation with the
 * watched run's source annotation, so the queued document carries no
 * automation part.
 */
function setupSourceAnnotatedAutomationPage({
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
        id: SOURCE_EVENT_ID,
        eventType: "input.automation",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: SOURCE_EVENT_TEXT },
            {
              type: "source",
              kind: "agent",
              runId: SOURCE_RUN_ID,
              threadId: SOURCE_THREAD_ID,
              agentId: SOURCE_AGENT_ID,
              titleSnapshot: "Watched chat run",
              href: `/chats/${SOURCE_THREAD_ID}#run-${SOURCE_RUN_ID}`,
            },
          ],
        },
        runId: undefined,
        createdAt: "2026-07-10T01:03:00Z",
      },
    ],
    activeRunIds: ["run-workflow-1"],
    onRecallEventAppend,
  });

  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });
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
        eventType: "goal.open",
        role: "assistant",
        content: "Keep customer follow-ups under four hours",
        runId: undefined,
        createdAt: "2026-07-10T01:00:01Z",
      },
      {
        id: EVENT_ID_1,
        eventType: "input.automation",
        content: null,
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
  it("renders active-run prompts inline while queueing automation events and the active goal", async () => {
    setupWorkflowQueuePage();

    await waitFor(() => {
      expect(screen.getByText("2 events waiting")).toBeInTheDocument();
      expect(
        screen.getByText("Review the queued customer reply"),
      ).toBeInTheDocument();
      expect(screen.getByText("customer-followup")).toBeInTheDocument();
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
      "Pending automation event",
      "Pending automation event",
      "Active goal",
    ]);
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
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
      expect(screen.getByText("customer-followup")).toBeInTheDocument();
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
      expect(screen.queryByText("customer-followup")).not.toBeInTheDocument();
      expect(screen.getByText("Webhook event third")).toBeInTheDocument();
    });
  });

  it("queues a source-annotated automation event as an event row", async () => {
    setupSourceAnnotatedAutomationPage();

    await waitFor(() => {
      expect(screen.getByText("1 event waiting")).toBeInTheDocument();
    });
    expect(screen.getByText(SOURCE_EVENT_TEXT)).toBeInTheDocument();
    expect(
      screen.getByLabelText("Pending automation event"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
  });

  it("skips a source-annotated automation event", async () => {
    let recall: { revokesEventId: string; clientEventId: string } | undefined;
    setupSourceAnnotatedAutomationPage({
      onRecallEventAppend: (body) => {
        recall = body;
      },
    });
    await waitFor(() => {
      expect(screen.getByText(SOURCE_EVENT_TEXT)).toBeInTheDocument();
    });

    click(buttonByLabel("Skip automation event"));

    await waitFor(() => {
      expect(recall?.revokesEventId).toBe(SOURCE_EVENT_ID);
      expect(screen.queryByText(SOURCE_EVENT_TEXT)).not.toBeInTheDocument();
    });
  });
});
