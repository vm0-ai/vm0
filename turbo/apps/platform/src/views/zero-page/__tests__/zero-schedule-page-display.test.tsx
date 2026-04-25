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
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroSchedulesMainContract,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const mockApi = createMockApi(context);

function createMockSchedules(): ScheduleResponse[] {
  return [
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000001",
      displayName: "morning-briefing",
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
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /list/i.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getAllByRole("tab").find((el) => {
        return /calendar/i.test(el.textContent ?? "");
      }),
    ).toBeInTheDocument();
  });

  it("should NOT show a History tab (SCHED-TABS-002)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /list/i.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });

    // History tab should not exist
    const historyTabs = screen.getAllByRole("tab").filter((el) => {
      return /history/i.test(el.textContent ?? "");
    });
    expect(historyTabs).toHaveLength(0);
  });

  it("should switch to calendar view when Calendar tab is clicked (SCHED-TABS-003)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /list/i.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByRole("tab").find((el) => {
        return /calendar/i.test(el.textContent ?? "");
      })!,
    );

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });

  it("should switch back to list view when List tab is clicked (SCHED-TABS-004)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /list/i.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });

    // Go to calendar first
    click(
      screen.getAllByRole("tab").find((el) => {
        return /calendar/i.test(el.textContent ?? "");
      })!,
    );
    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });

    // Go back to list
    click(
      screen.getAllByRole("tab").find((el) => {
        return /list/i.test(el.textContent ?? "");
      })!,
    );
    await waitFor(() => {
      expect(screen.getAllByText("morning-briefing").length).toBeGreaterThan(0);
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
      expect(screen.getAllByText("morning-briefing").length).toBeGreaterThan(0);
    });
    expect(
      screen.getAllByText("Summarize yesterday's threads").length,
    ).toBeGreaterThan(0);
  });

  it("should render schedule entries in calendar view (SCHED-DISP-003)", async () => {
    mockScheduleAPI();
    renderSchedulePage();

    await waitFor(() => {
      expect(screen.getAllByText("morning-briefing").length).toBeGreaterThan(0);
    });

    click(
      screen.getAllByRole("tab").find((el) => {
        return /calendar/i.test(el.textContent ?? "");
      })!,
    );

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

    // Wait for the loading state to resolve before the test ends to prevent
    // async re-renders from triggering ErrorBoundary during afterEach cleanup.
    await waitFor(() => {
      expect(
        screen.queryByTestId("schedule-list-skeleton"),
      ).not.toBeInTheDocument();
    });
  });
});
