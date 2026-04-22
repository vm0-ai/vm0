import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScheduleResponse } from "@vm0/core";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { setCalendarSelectedDay$ } from "../../../signals/schedule-page/schedule-page-ui.ts";
import { setMockSchedules } from "../../../mocks/handlers/api-schedules.ts";

const context = testContext();

function mockScheduleBase() {
  return {
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    nextRunAt: null,
    lastRunAt: null,
    modelProviderId: null,
    selectedModel: null,
  };
}

function weekdaySchedule(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    ...mockScheduleBase(),
    id: "f0000001-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Summarize yesterday's threads",
    description: "Morning briefing",
    enabled: true,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

// Monday-only schedule — used with an explicit calendarSelectedDay$ override
// (see SCHED-D-077/079) so that only the desktop Mon column renders an entry.
// Without the override the mobile view follows today's day, which may also be
// Monday, producing two simultaneous CalendarEntryPopover instances and
// causing DismissableLayer conflicts in happy-dom.
function mondayOnlySchedule(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    ...mockScheduleBase(),
    id: "f0000001-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Summarize yesterday's threads",
    description: "Morning briefing",
    enabled: true,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function loopSchedule(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    ...mockScheduleBase(),
    id: "f0000001-0000-4000-a000-000000000002",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "inbox-check",
    triggerType: "loop",
    cronExpression: null,
    atTime: null,
    intervalSeconds: 900,
    timezone: "UTC",
    prompt: "Check inbox",
    description: null,
    enabled: true,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function monthlySchedule(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    ...mockScheduleBase(),
    id: "f0000001-0000-4000-a000-000000000003",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "monthly-report",
    triggerType: "cron",
    cronExpression: "0 9 1 * *",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Generate monthly report",
    description: null,
    enabled: true,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function onceSchedule(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    ...mockScheduleBase(),
    id: "f0000001-0000-4000-a000-000000000004",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "one-time-task",
    triggerType: "once",
    cronExpression: null,
    atTime: "2026-05-01T09:00:00Z",
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "One-time task",
    description: null,
    enabled: true,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function mockScheduleAPI(schedules: ScheduleResponse[]) {
  setMockSchedules(schedules);
}

async function switchToCalendarView() {
  // Wait for the page to finish loading (schedule list or empty state is visible)
  await waitFor(() => {
    const hasScheduled =
      screen.queryAllByLabelText(/More actions for/i).length > 0;
    const hasEmpty = screen.queryByText("No runs scheduled") !== null;
    const hasTab = screen.queryAllByRole("tab").some((el) => {
      return /Calendar/i.test(el.textContent ?? "");
    });
    if (!hasTab || (!hasScheduled && !hasEmpty)) {
      throw new Error("page not loaded");
    }
  });
  const calendarTab = screen.getAllByRole("tab").find((el) => {
    return /Calendar/i.test(el.textContent ?? "");
  });
  expect(calendarTab).toBeDefined();
  click(calendarTab!);
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Week view" }),
    ).toBeInTheDocument();
  });
}

describe("schedule calendar view - schedule entries in cells (SCHED-D-068)", () => {
  it("shows schedule entries in their corresponding time slots", async () => {
    mockScheduleAPI([weekdaySchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    await switchToCalendarView();

    await waitFor(() => {
      expect(screen.getAllByLabelText(/Morning briefing/i)[0]).toBeDefined();
    });
  });
});

describe("schedule calendar view - agent labels with color coding (SCHED-D-069)", () => {
  it("shows agent label on each entry button aria-label", async () => {
    mockScheduleAPI([
      weekdaySchedule({
        id: "f0000002-0000-4000-a000-000000000001",
        agentId: "c0000000-0000-4000-a000-000000000002",
        displayName: "Alpha",
      }),
      weekdaySchedule({
        id: "f0000002-0000-4000-a000-000000000002",
        agentId: "c0000000-0000-4000-a000-000000000003",
        displayName: "Beta",
        name: "beta-task",
        prompt: "Beta task",
        description: "Beta task",
        cronExpression: "0 9 * * 1-5",
      }),
    ]);
    detachedSetupPage({ context, path: "/schedules" });
    await switchToCalendarView();

    await waitFor(() => {
      expect(screen.getAllByLabelText(/Alpha:/i)[0]).toBeDefined();
      expect(screen.getAllByLabelText(/Beta:/i)[0]).toBeDefined();
    });
  });
});

describe("schedule calendar view - loop/monthly/once sections (SCHED-D-071)", () => {
  it("renders loop, monthly, and once schedule entries in their respective sections", async () => {
    mockScheduleAPI([loopSchedule(), monthlySchedule(), onceSchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    await switchToCalendarView();

    await waitFor(() => {
      // Each schedule type renders its own section heading
      expect(screen.getByRole("heading", { name: "Loop" })).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Monthly" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Once" })).toBeInTheDocument();
      // Each section renders exactly one edit button for its single entry
      expect(screen.getAllByLabelText(/^Edit /i)).toHaveLength(3);
    });
  });
});

describe("schedule calendar view - mobile single day view (SCHED-D-072)", () => {
  it("shows previous day and next day navigation buttons for mobile view", async () => {
    mockScheduleAPI([weekdaySchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    await switchToCalendarView();

    await waitFor(() => {
      expect(screen.getByLabelText("Previous day")).toBeDefined();
      expect(screen.getByLabelText("Next day")).toBeDefined();
    });
  });
});

describe("schedule calendar view - previous day navigation (SCHED-D-075)", () => {
  it("shifts to the previous day when Previous day button is clicked", async () => {
    mockScheduleAPI([weekdaySchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    await switchToCalendarView();

    const navBar = await screen.findByRole("navigation", {
      name: "Day navigation",
    });
    const initialLabel = navBar.textContent;

    const prevDayBtn = screen.getByLabelText("Previous day");
    click(prevDayBtn);

    await waitFor(() => {
      expect(navBar.textContent).not.toBe(initialLabel);
    });
  });
});

describe("schedule calendar view - next day navigation (SCHED-D-076)", () => {
  it("shifts to the next day when Next day button is clicked", async () => {
    mockScheduleAPI([weekdaySchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    await switchToCalendarView();

    const navBar = await screen.findByRole("navigation", {
      name: "Day navigation",
    });
    const initialLabel = navBar.textContent;

    const nextDayBtn = screen.getByLabelText("Next day");
    click(nextDayBtn);

    await waitFor(() => {
      expect(navBar.textContent).not.toBe(initialLabel);
    });
  });
});

describe("schedule calendar view - entry popover on hover (SCHED-D-077)", () => {
  it("shows a popover with schedule details on mouseenter", async () => {
    const user = userEvent.setup();
    // Monday-only schedule: only one desktop entry renders.
    // Pin mobile to Friday so the mobile view has no entry and there is
    // only one CalendarEntryPopover instance — avoids DismissableLayer
    // conflicts when two popover instances are open simultaneously in happy-dom.
    mockScheduleAPI([mondayOnlySchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    context.store.set(setCalendarSelectedDay$, 4); // Friday — no Monday entry in mobile
    await switchToCalendarView();

    const entryBtn = await waitFor(() => {
      return screen.getAllByLabelText(/Morning briefing/i)[0];
    });
    await user.hover(entryBtn);

    await waitFor(() => {
      expect(
        screen.getByText("Summarize yesterday's threads"),
      ).toBeInTheDocument();
    });
  });
});

describe("schedule calendar view - double-click opens edit (SCHED-D-078)", () => {
  it("navigates to schedule detail on double-click", async () => {
    const user = userEvent.setup();
    mockScheduleAPI([weekdaySchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    await switchToCalendarView();

    const entryBtns = await waitFor(() => {
      const btns = screen.getAllByLabelText(/Morning briefing/i);
      expect(btns.length).toBeGreaterThan(0);
      return btns;
    });
    await user.dblClick(entryBtns[0]);

    await waitFor(() => {
      expect(pathname()).toBe(
        "/schedules/f0000001-0000-4000-a000-000000000001",
      );
    });
  });
});

describe("schedule calendar view - edit button in popover (SCHED-D-079)", () => {
  it("navigates to schedule detail when edit button in popover is clicked", async () => {
    const user = userEvent.setup();
    // Monday-only schedule: only one desktop entry renders.
    // Pin mobile to Friday — same reasoning as SCHED-D-077.
    mockScheduleAPI([mondayOnlySchedule()]);
    detachedSetupPage({ context, path: "/schedules" });
    context.store.set(setCalendarSelectedDay$, 4); // Friday — no Monday entry in mobile
    await switchToCalendarView();

    const entryBtn = await waitFor(() => {
      return screen.getAllByLabelText(/Morning briefing/i)[0];
    });

    // Hover the entry button to open the popover, then immediately move the
    // pointer into the PopoverContent (portal) to keep it open via its
    // own onMouseEnter handler, and click the edit button.
    await user.hover(entryBtn);

    const editBtn = await waitFor(() => {
      return screen.getByLabelText(/Edit Every week/i);
    });
    await user.pointer({ target: editBtn, keys: "[MouseLeft]" });

    await waitFor(() => {
      expect(pathname()).toBe(
        "/schedules/f0000001-0000-4000-a000-000000000001",
      );
    });
  });
});
