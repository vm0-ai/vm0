import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ScheduleResponse } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const AGENT_ID = "e0000000-0000-4000-a000-000000000010";

function defaultSchedule(
  overrides: Partial<ScheduleResponse> = {},
): ScheduleResponse {
  return {
    id: "f0000002-0000-4000-a000-000000000001",
    agentId: AGENT_ID,
    displayName: null,
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Summarize yesterday's threads",
    description: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function mockBaseAPIs(schedules: ScheduleResponse[]) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-detail-id",
          name: "my-agent",
          displayName: "My Agent",
          description: "A helpful agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: AGENT_ID,
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        connectors: [],
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules });
    }),
  );
}

async function navigateToScheduleTab() {
  await setupPage({ context, path: "/agents/my-agent?tab=schedule" });
}

async function openMenuAndClick(
  user: ReturnType<typeof userEvent.setup>,
  timeLabel: string,
  action: "Edit" | "Delete" | "Run now",
) {
  const menuTrigger = screen.getAllByLabelText(
    `More actions for ${timeLabel}`,
  )[0];
  await user.click(menuTrigger);
  await waitFor(() => {
    expect(
      screen.getAllByRole("menuitem").find((el) => {
        return el.textContent?.includes(action);
      }),
    ).toBeDefined();
  });
  const item = screen.getAllByRole("menuitem").find((el) => {
    return el.textContent?.includes(action);
  });
  expect(item).toBeDefined();
  await user.click(item as HTMLElement);
}

describe("zero-schedule-card - schedule list", () => {
  it("renders schedule entries in card list view (SCHED-D-034)", async () => {
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });
  });

  it("renders the formatted time for each schedule entry (SCHED-D-035)", async () => {
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText(/Every weekday at 9:00 AM/)[0],
      ).toBeInTheDocument();
    });
  });

  it("renders the prompt text for each schedule entry (SCHED-D-036)", async () => {
    mockBaseAPIs([
      defaultSchedule({ prompt: "Check overnight alerts and summarize" }),
    ]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Check overnight alerts and summarize")[0],
      ).toBeInTheDocument();
    });
  });

  it("renders ZeroScheduleCard with agent displayName in title (SCHED-D-045)", async () => {
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getByText("My Agent's scheduled tasks"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero-schedule-card - view mode", () => {
  it("shows List and Calendar view tabs with list view active by default (SCHED-D-037)", async () => {
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    // Both view mode tabs should be present in the card header
    const listTab = screen.getAllByRole("tab").find((el) => {
      return /^List$/i.test(el.textContent?.trim() ?? "");
    });
    const calendarTab = screen.getAllByRole("tab").find((el) => {
      return /^Calendar$/i.test(el.textContent?.trim() ?? "");
    });
    expect(listTab).toBeDefined();
    expect(calendarTab).toBeDefined();
    // List view is showing (no "Week view" heading visible)
    expect(screen.queryByText("Week view")).not.toBeInTheDocument();
  });

  it("switches to calendar view when Calendar tab is clicked (SCHED-D-040)", async () => {
    const user = userEvent.setup();
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    const calendarTab = screen.getAllByRole("tab").find((el) => {
      return /Calendar/i.test(el.textContent ?? "");
    });
    expect(calendarTab).toBeDefined();
    await user.click(calendarTab as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });
});

describe("zero-schedule-card - add schedule dialog", () => {
  it("opens schedule form dialog when Add schedule button is clicked (SCHED-D-039)", async () => {
    const user = userEvent.setup();
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add schedule"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });
});

describe("zero-schedule-card - save error", () => {
  it("displays save error message in dialog when schedule save fails (SCHED-D-038)", async () => {
    const user = userEvent.setup();
    mockBaseAPIs([defaultSchedule()]);
    server.use(
      http.post("*/api/zero/schedules", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Schedule limit reached",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 400 },
        );
      }),
    );
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add schedule"));

    await waitFor(() => {
      expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Prompt"), "New task");
    await user.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(
        within(screen.getByRole("dialog")).getByText(/Schedule limit reached/),
      ).toBeInTheDocument();
    });
  });
});

describe("zero-schedule-card - delete", () => {
  it("closing delete dialog preserves the schedule entry (SCHED-D-041)", async () => {
    const user = userEvent.setup();
    let deleteCalled = false;
    mockBaseAPIs([defaultSchedule()]);
    server.use(
      http.delete("*/api/zero/schedules/:name", () => {
        deleteCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deleteCalled).toBeFalsy();
    expect(
      screen.getAllByText("Summarize yesterday's threads")[0],
    ).toBeInTheDocument();
  });

  it("calls delete API when delete is confirmed (SCHED-D-042)", async () => {
    const user = userEvent.setup();
    let deletedName: string | null = null;
    mockBaseAPIs([defaultSchedule()]);
    server.use(
      http.delete("*/api/zero/schedules/:name", ({ params }) => {
        deletedName = params["name"] as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(deletedName).toBe("morning-briefing");
    });
  });
});

describe("zero-schedule-tab - loading state", () => {
  it("renders skeleton while schedule data is loading (SCHED-D-043)", async () => {
    const hangDeferred = createDeferredPromise<void>(context.signal);
    mockBaseAPIs([defaultSchedule()]);
    server.use(
      http.get("*/api/zero/schedules", async () => {
        await hangDeferred.promise;
        return HttpResponse.json({ schedules: [] });
      }),
    );

    const pagePromise = setupPage({
      context,
      path: "/agents/my-agent?tab=schedule",
    });

    await waitFor(() => {
      expect(screen.getByTestId("schedule-tab-skeleton")).toBeInTheDocument();
    });

    hangDeferred.resolve();
    await pagePromise;
  });
});

describe("zero-schedule-tab - error state", () => {
  it("displays error message when schedule fetch fails (SCHED-D-044)", async () => {
    mockBaseAPIs([]);
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Failed to load schedules",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 500 },
        );
      }),
    );

    await navigateToScheduleTab();

    await waitFor(() => {
      expect(screen.getByText("Failed to load schedules")).toBeInTheDocument();
    });
  });
});
