import { screen, waitFor } from "@testing-library/react";
import {
  zeroWorkflowQueueContract,
  type WorkflowQueueResponse,
} from "@vm0/api-contracts/contracts/zero-workflow-queue";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  createMockWorkflowTrigger,
  setMockWorkflowTriggers,
} from "../../../mocks/handlers/workflow-triggers-store.ts";
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
        triggerId: "e0000001-0000-4000-a000-000000000001",
        triggerSource: "workflow-event",
        triggerBrief: "Webhook event second",
        createdAt: "2026-07-10T01:01:00Z",
      },
      {
        id: EVENT_ID_2,
        triggerId: "e0000001-0000-4000-a000-000000000001",
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

async function openAutomationsPanel(
  workflowQueueEnabled = true,
): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Workflow queue thread",
    historyMessages: [
      {
        role: "user",
        content: "Trigger run",
        createdAt: "2026-07-10T00:59:00Z",
      },
    ],
  });
  setMockWorkflowTriggers([
    createMockWorkflowTrigger({
      chatThreadId: THREAD_ID,
      kind: "event",
      eventType: "gmail-new-message",
    }),
  ]);

  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.WorkflowQueue]: workflowQueueEnabled,
    },
  });

  await waitFor(() => {
    expect(buttonByLabel("Automations")).toBeInTheDocument();
  });
  click(buttonByLabel("Automations"));
  await waitFor(() => {
    expect(screen.getByTestId("automation-sidebar")).toBeInTheDocument();
  });
}

describe("workflow queue panel", () => {
  it("shows the pending badge, running event, and FIFO pending list", async () => {
    context.mocks.api(zeroWorkflowQueueContract.get, ({ respond }) => {
      return respond(200, queueResponse());
    });

    await openAutomationsPanel();

    await waitFor(() => {
      const badges = screen.getAllByTestId("workflow-queue-badge");
      expect(badges.length).toBeGreaterThan(0);
      expect(badges[0]).toHaveTextContent("2");
      expect(screen.getByTestId("workflow-queue-section")).toBeInTheDocument();
      expect(screen.getByText("2 waiting")).toBeInTheDocument();
      expect(screen.getByText("Webhook event busy")).toBeInTheDocument();
      expect(screen.getByText("Webhook event second")).toBeInTheDocument();
      expect(screen.getByText("Webhook event third")).toBeInTheDocument();
    });
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

    await openAutomationsPanel();
    await waitFor(() => {
      expect(screen.getByText("Webhook event second")).toBeInTheDocument();
    });

    const skipButtons = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Skip queued event";
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

    await openAutomationsPanel();
    await waitFor(() => {
      expect(buttonByLabel("Pause queue")).toBeInTheDocument();
    });
    click(buttonByLabel("Pause queue"));

    await waitFor(() => {
      expect(screen.getByText(/Queue paused/)).toBeInTheDocument();
      expect(buttonByLabel("Resume queue")).toBeInTheDocument();
    });
  });

  it("hides the queue UI when the feature switch is off", async () => {
    context.mocks.api(zeroWorkflowQueueContract.get, ({ respond }) => {
      return respond(200, queueResponse());
    });

    await openAutomationsPanel(false);

    await waitFor(() => {
      expect(
        screen.queryByTestId("workflow-queue-section"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("workflow-queue-badge"),
      ).not.toBeInTheDocument();
    });
  });
});
