/**
 * Tests for the QueueDrawer component.
 *
 * The queue drawer shows current plan status and an upsell to the next tier.
 * Free → Pro, Pro → Team, Team → no upsell.
 *
 * Entry point: setupPage({ context, path: "/" }) + store.set(openQueueDrawer$)
 * Mock (external): HTTP via MSW
 * Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { openQueueDrawer$ } from "../../../signals/queue-page/queue-drawer-state.ts";
import { pathname$ } from "../../../signals/route.ts";
import { mockChatLifecycle } from "../../zero-page/__tests__/chat-test-helpers.ts";

const context = testContext();

function mockHomeAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function queueResponse(overrides?: {
  concurrency?: {
    tier: string;
    limit: number;
    active: number;
    available: number;
  };
}) {
  return {
    concurrency: overrides?.concurrency ?? {
      tier: "free",
      limit: 1,
      active: 1,
      available: 0,
    },
    queue: [],
    runningTasks: [],
    estimatedTimePerRun: null,
  };
}

function openDrawer() {
  mockHomeAPIs();
  detachedSetupPage({ context, path: "/" });
  context.store.set(openQueueDrawer$);
}

describe("queue drawer", () => {
  it("shows title when opened", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(queueResponse());
      }),
    );
    await openDrawer();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /waiting in line/ }),
      ).toBeInTheDocument();
    });
  });

  it("shows Free label and limitation for free tier", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
          }),
        );
      }),
    );
    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Free")).toBeInTheDocument();
      expect(screen.getByText(/only run 1 task/)).toBeInTheDocument();
    });
  });

  it("shows Pro upsell for free tier", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
          }),
        );
      }),
    );
    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Pro")).toBeInTheDocument();
      expect(screen.getByText("$20")).toBeInTheDocument();
      expect(
        screen.getAllByText("2 concurrent runs").length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows Team upsell for pro tier", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "pro", limit: 2, active: 2, available: 0 },
          }),
        );
      }),
    );
    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeInTheDocument();
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Team")).toBeInTheDocument();
      expect(screen.getByText("$200")).toBeInTheDocument();
      expect(
        screen.getAllByText("5 concurrent runs").length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows no upsell for team tier", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "team", limit: 5, active: 3, available: 2 },
          }),
        );
      }),
    );
    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.getByText(/3 of 5 slots/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/Upgrade to/)).not.toBeInTheDocument();
  });

  it("clicking 'View queue' in chat should open drawer without navigating away", async () => {
    const user = userEvent.setup();

    const ctrl = mockChatLifecycle({
      unsavedRuns: [
        {
          runId: "run-queue-1",
          status: "queued",
          prompt: "Do something",
          error: null,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    ctrl.setRunStatus("queued");
    ctrl.setQueuePosition(2);

    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const link = await waitFor(() => {
      return screen.getByText("View queue");
    });

    expect(context.store.get(pathname$)).toBe("/chats/thread-test-1");

    await user.click(link);

    // Should stay on the chat page and open the queue drawer in-place
    expect(context.store.get(pathname$)).toBe("/chats/thread-test-1");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /waiting in line/ }),
      ).toBeInTheDocument();
    });
  });
});
