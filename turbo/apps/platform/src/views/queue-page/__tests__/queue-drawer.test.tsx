import { screen, waitFor } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-queue";

function queueResponse(overrides?: {
  concurrency?: {
    tier: "free" | "pro-suspend" | "pro" | "team";
    limit: number;
    active: number;
    available: number;
  };
}) {
  return {
    concurrency: overrides?.concurrency ?? {
      tier: "free" as const,
      limit: 1,
      active: 1,
      available: 0,
    },
    queue: [],
    runningTasks: [],
    estimatedTimePerRun: null,
  };
}

function mockQueuedThread(): void {
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceId) {
      return respond(200, { messages: [] });
    }

    return respond(200, {
      messages: [
        {
          id: "msg-previous-user",
          role: "user",
          content: "Previous prompt",
          runId: "run-completed",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "msg-previous-assistant",
          role: "assistant",
          content: "Previous answer",
          runId: "run-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-01-01T00:00:01Z",
        },
        {
          id: "msg-queued-marker",
          role: "assistant",
          content: "Waiting in queue...",
          runId: "run-queued",
          runEventId: "queue:queued",
          createdAt: "2026-01-01T00:00:02Z",
        },
      ],
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      title: null,
      agentId: "c0000000-0000-4000-a000-000000000001",
      latestSessionId: null,
      activeRunIds: ["run-queued"],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((el) => {
    return el.textContent?.trim() === text;
  });

  if (!button) {
    throw new Error(`Could not find button: ${text}`);
  }

  return button;
}

async function openDrawer(): Promise<void> {
  mockQueuedThread();
  detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });
  const queueButton = await waitFor(() => {
    return getButtonByText("queue...");
  });
  click(queueButton);
}

describe("queue drawer", () => {
  it("shows the free tier limit and upgrade path", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /waiting in line/ }),
      ).toBeInTheDocument();
      expect(screen.getByText("Free")).toBeInTheDocument();
      expect(screen.getByText(/only run 1 task/)).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Pro")).toBeInTheDocument();
    });
  });

  it("shows the Team upgrade path for Pro tier", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "pro", limit: 2, active: 2, available: 0 },
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Team")).toBeInTheDocument();
    });
  });

  it("shows no upgrade path for Team tier", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "team", limit: 5, active: 3, available: 2 },
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.getByText(/3 of 5 slots/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Upgrade to/)).not.toBeInTheDocument();
  });
});
