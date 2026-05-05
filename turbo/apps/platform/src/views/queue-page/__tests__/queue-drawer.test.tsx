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
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { openQueueDrawer$ } from "../../../signals/queue-page/queue-drawer-state.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";

const context = testContext();
const mockApi = createMockApi(context);

function mockHomeAPIs() {
  // Global handlers cover chat-threads and team routes
}

function queueResponse(overrides?: {
  concurrency?: {
    tier: "free" | "pro" | "team";
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

function openDrawer() {
  mockHomeAPIs();
  detachedSetupPage({ context, path: "/" });
  context.store.set(openQueueDrawer$, context.signal);
}

describe("queue drawer", () => {
  it("shows title when opened", async () => {
    server.use(
      mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
        return respond(200, queueResponse());
      }),
    );
    openDrawer();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /waiting in line/ }),
      ).toBeInTheDocument();
    });
  });

  it("shows Free label and limitation for free tier", async () => {
    server.use(
      mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
        return respond(
          200,
          queueResponse({
            concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
          }),
        );
      }),
    );
    openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Free")).toBeInTheDocument();
      expect(screen.getByText(/only run 1 task/)).toBeInTheDocument();
    });
  });

  it("shows Pro upsell for free tier", async () => {
    server.use(
      mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
        return respond(
          200,
          queueResponse({
            concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
          }),
        );
      }),
    );
    openDrawer();

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
      mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
        return respond(
          200,
          queueResponse({
            concurrency: { tier: "pro", limit: 2, active: 2, available: 0 },
          }),
        );
      }),
    );
    openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeInTheDocument();
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Team")).toBeInTheDocument();
      expect(screen.getByText("$200")).toBeInTheDocument();
      expect(
        screen.getAllByText("10 concurrent runs").length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows no upsell for team tier", async () => {
    server.use(
      mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
        return respond(
          200,
          queueResponse({
            concurrency: { tier: "team", limit: 5, active: 3, available: 2 },
          }),
        );
      }),
    );
    openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.getByText(/3 of 5 slots/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/Upgrade to/)).not.toBeInTheDocument();
  });
});
