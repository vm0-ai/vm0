/**
 * Tests for zero-schedule-page.tsx
 *
 * Tests the schedule page after removing ScheduleRunHistory feature switch.
 * Verifies that only list and calendar tabs are available (no history tab).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroSchedulesMainContract,
  type ScheduleResponse,
} from "@vm0/core/contracts/zero-schedules";

const context = testContext();
const mockApi = createMockApi(context);

function createMockSchedules(): ScheduleResponse[] {
  return [
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000001",
      displayName: "Zero",
      name: "morning-briefing",
      cronExpression: "0 9 * * 1-5",
      prompt: "Summarize yesterday's threads",
    }),
  ];
}

function mockScheduleAPI(schedules = createMockSchedules()) {
  setMockSchedules(schedules);
}

function renderSchedulePage() {
  detachedSetupPage({ context, path: "/schedules" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("zero schedule page - view tabs (post run-history removal)", () => {
  it("should only show List and Calendar tabs (SCHED-TABS-001)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /list/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: /calendar/i })).toBeInTheDocument();
  });

  it("should NOT show a History tab (SCHED-TABS-002)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /list/i })).toBeInTheDocument();
    });

    // History tab should not exist
    const historyTabs = screen.queryAllByRole("tab", { name: /history/i });
    expect(historyTabs).toHaveLength(0);
  });

  it("should switch to calendar view when Calendar tab is clicked (SCHED-TABS-003)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /list/i })).toBeInTheDocument();
    });

    click(screen.getByRole("tab", { name: /calendar/i }));

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });

  it("should switch back to list view when List tab is clicked (SCHED-TABS-004)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /list/i })).toBeInTheDocument();
    });

    // Go to calendar first
    click(screen.getByRole("tab", { name: /calendar/i }));
    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });

    // Go back to list
    click(screen.getByRole("tab", { name: /list/i }));
    await waitFor(() => {
      expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    });
  });
});

describe("zero schedule page - display after refactor", () => {
  it("should still display page title and subtitle (SCHED-DISP-001)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Automated tasks scheduled across all agents in your workspace.",
      ),
    ).toBeInTheDocument();
  });

  it("should render schedule entries in list view (SCHED-DISP-002)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    });
    expect(screen.getByText("Summarize yesterday's threads")).toBeInTheDocument();
  });

  it("should render schedule entries in calendar view (SCHED-DISP-003)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    });

    click(screen.getByRole("tab", { name: /calendar/i }));

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });

  it("should show skeleton while loading (SCHED-DISP-004)", async () => {
    const hangDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(zeroSchedulesMainContract.list, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(200, { schedules: [] });
      }),
    );

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByTestId("schedule-list-skeleton")).toBeInTheDocument();
    });

    hangDeferred.resolve();
  });
});

// Helper for deferred promise
function createDeferredPromise<T>(signal: AbortSignal): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  signal.addEventListener("abort", () => {
    rej(new Error("Aborted"));
  });
  return { promise, resolve: resolve!, reject: reject! };
}
