import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

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
  };
}

function weekdaySchedule(overrides: Record<string, unknown> = {}) {
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

// Monday-only schedule — renders exactly one CalendarEntryPopover instance
// (desktop Mon column only; mobile shows Fri and has no entry since today is Fri)
function mondayOnlySchedule(overrides: Record<string, unknown> = {}) {
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

function loopSchedule(overrides: Record<string, unknown> = {}) {
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

function monthlySchedule(overrides: Record<string, unknown> = {}) {
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

function onceSchedule(overrides: Record<string, unknown> = {}) {
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

function mockScheduleAPI(schedules: unknown[]) {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function switchToCalendarView(user: ReturnType<typeof userEvent.setup>) {
  // Wait for the page to finish loading (schedule list or empty state is visible)
  await waitFor(() => {
    const hasScheduled =
      screen.queryAllByRole("button", { name: /More actions for/ }).length > 0;
    const hasEmpty = screen.queryByText("No runs scheduled") !== null;
    const hasTab = screen.queryByRole("tab", { name: /Calendar/i }) !== null;
    if (!hasTab || (!hasScheduled && !hasEmpty)) {
      throw new Error("page not loaded");
    }
  });
  await user.click(screen.getByRole("tab", { name: /Calendar/i }));
  await waitFor(() => {
    expect(screen.getByText("Week view")).toBeInTheDocument();
  });
}

describe("schedule calendar view - schedule entries in cells (SCHED-D-068)", () => {
  it("shows schedule entries in their corresponding time slots", async () => {
    const user = userEvent.setup();
    mockScheduleAPI([weekdaySchedule()]);
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /Morning briefing/i })[0],
      ).toBeInTheDocument();
    });
  });
});

describe("schedule calendar view - agent labels with color coding (SCHED-D-069)", () => {
  it("shows agent label on each entry button aria-label", async () => {
    const user = userEvent.setup();
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
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /Alpha:/i })[0],
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole("button", { name: /Beta:/i })[0],
      ).toBeInTheDocument();
    });
  });
});

describe("schedule calendar view - loop/monthly/once sections (SCHED-D-071)", () => {
  it("renders loop, monthly, and once schedule entries in their respective sections", async () => {
    const user = userEvent.setup();
    mockScheduleAPI([loopSchedule(), monthlySchedule(), onceSchedule()]);
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    await waitFor(() => {
      expect(screen.getByText("Every 15 minutes")).toBeInTheDocument();
      expect(
        screen.getByText("Every month on day 1 at 9:00 AM"),
      ).toBeInTheDocument();
      expect(screen.getByText(/Once on/i)).toBeInTheDocument();
    });
  });
});

describe("schedule calendar view - mobile single day view (SCHED-D-072)", () => {
  it("shows previous day and next day navigation buttons for mobile view", async () => {
    const user = userEvent.setup();
    mockScheduleAPI([weekdaySchedule()]);
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Previous day" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Next day" }),
      ).toBeInTheDocument();
    });
  });
});

describe("schedule calendar view - previous day navigation (SCHED-D-075)", () => {
  it("shifts to the previous day when Previous day button is clicked", async () => {
    const user = userEvent.setup();
    mockScheduleAPI([weekdaySchedule()]);
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    const prevBtn = await screen.findByRole("button", { name: "Previous day" });
    // The nav bar is the common parent of both nav buttons and the day label span
    const navBar = prevBtn.parentElement;
    if (!navBar) {
      throw new Error("Could not find nav bar");
    }
    const initialLabel = navBar.textContent;

    await user.click(prevBtn);

    await waitFor(() => {
      expect(navBar.textContent).not.toBe(initialLabel);
    });
  });
});

describe("schedule calendar view - next day navigation (SCHED-D-076)", () => {
  it("shifts to the next day when Next day button is clicked", async () => {
    const user = userEvent.setup();
    mockScheduleAPI([weekdaySchedule()]);
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    const nextBtn = await screen.findByRole("button", { name: "Next day" });
    // The nav bar is the common parent of both nav buttons and the day label span
    const navBar = nextBtn.parentElement;
    if (!navBar) {
      throw new Error("Could not find nav bar");
    }
    const initialLabel = navBar.textContent;

    await user.click(nextBtn);

    await waitFor(() => {
      expect(navBar.textContent).not.toBe(initialLabel);
    });
  });
});

describe("schedule calendar view - entry popover on hover (SCHED-D-077)", () => {
  it("shows a popover with schedule details on mouseenter", async () => {
    const user = userEvent.setup();
    // Use a Monday-only schedule so only one CalendarEntryPopover instance
    // renders in the desktop grid (avoids DismissableLayer conflicts with
    // multiple simultaneous popover instances in happy-dom)
    mockScheduleAPI([mondayOnlySchedule()]);
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    const entryBtn = await screen.findByRole("button", {
      name: /Morning briefing/i,
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
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    const entryBtns = await screen.findAllByRole("button", {
      name: /Morning briefing/i,
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
    // Use a Monday-only schedule for a single popover instance
    mockScheduleAPI([mondayOnlySchedule()]);
    await setupPage({ context, path: "/schedules" });
    await switchToCalendarView(user);

    const entryBtn = await screen.findByRole("button", {
      name: /Morning briefing/i,
    });

    // Hover the entry button to open the popover, then immediately move the
    // pointer into the PopoverContent (portal) to keep it open via its
    // own onMouseEnter handler, and click the edit button.
    await user.hover(entryBtn);

    const editBtn = await screen.findByRole("button", {
      name: /Edit Every week/i,
    });
    await user.pointer({ target: editBtn, keys: "[MouseLeft]" });

    await waitFor(() => {
      expect(pathname()).toBe(
        "/schedules/f0000001-0000-4000-a000-000000000001",
      );
    });
  });
});
