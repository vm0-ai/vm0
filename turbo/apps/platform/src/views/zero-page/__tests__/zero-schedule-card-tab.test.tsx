import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  type ScheduleResponse,
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockSchedules } from "../../../mocks/handlers/api-schedules.ts";

const context = testContext();
const mockApi = createMockApi(context);
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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    ...overrides,
  };
}

function mockBaseAPIs(schedules: ScheduleResponse[]) {
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-detail-id",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  setMockSchedules(schedules);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: AGENT_ID,
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

function navigateToScheduleTab() {
  detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });
}

async function openMenuAndClick(
  timeLabel: string,
  action: "Edit" | "Delete" | "Run now",
) {
  const menuTrigger = screen.getAllByLabelText(
    `More actions for ${timeLabel}`,
  )[0];
  click(menuTrigger);
  await waitFor(() => {
    expect(
      queryAllByRoleFast("menuitem").find((el) => {
        return el.textContent?.includes(action);
      }),
    ).toBeDefined();
  });
  const item = queryAllByRoleFast("menuitem").find((el) => {
    return el.textContent?.includes(action);
  });
  expect(item).toBeDefined();
  click(item as HTMLElement);
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
    const listTab = queryAllByRoleFast("tab").find((el) => {
      return /^List$/i.test(el.textContent?.trim() ?? "");
    });
    const calendarTab = queryAllByRoleFast("tab").find((el) => {
      return /^Calendar$/i.test(el.textContent?.trim() ?? "");
    });
    expect(listTab).toBeDefined();
    expect(calendarTab).toBeDefined();
    // List view is showing (no "Week view" heading visible)
    expect(screen.queryByText("Week view")).not.toBeInTheDocument();
  });

  it("switches to calendar view when Calendar tab is clicked (SCHED-D-040)", async () => {
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    const calendarTab = queryAllByRoleFast("tab").find((el) => {
      return /Calendar/i.test(el.textContent ?? "");
    });
    expect(calendarTab).toBeDefined();
    click(calendarTab as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });
});

describe("zero-schedule-card - add schedule dialog", () => {
  it("opens schedule form dialog when Add schedule button is clicked (SCHED-D-039)", async () => {
    mockBaseAPIs([defaultSchedule()]);
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    click(screen.getByText("Add schedule"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });
});

describe("zero-schedule-card - save error", () => {
  it("surfaces save error via toast when schedule save fails (SCHED-D-038)", async () => {
    mockBaseAPIs([defaultSchedule()]);
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
        return respond(400, {
          error: {
            message: "Schedule limit reached",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }),
    );
    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    click(screen.getByText("Add schedule"));

    await waitFor(() => {
      expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Prompt"), "New task");
    click(screen.getByText("Create"));

    await waitFor(() => {
      expect(screen.getByText(/Schedule limit reached/)).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("zero-schedule-card - delete", () => {
  it("closing delete dialog preserves the schedule entry (SCHED-D-041)", async () => {
    let deleteCalled = false;
    mockBaseAPIs([defaultSchedule()]);
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ respond }) => {
        deleteCalled = true;
        return respond(204);
      }),
    );

    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick("Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deleteCalled).toBeFalsy();
    expect(
      screen.getAllByText("Summarize yesterday's threads")[0],
    ).toBeInTheDocument();
  });

  it("calls delete API when delete is confirmed (SCHED-D-042)", async () => {
    let deletedName: string | null = null;
    mockBaseAPIs([defaultSchedule()]);
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ params, respond }) => {
        deletedName = params.name;
        return respond(204);
      }),
    );

    await navigateToScheduleTab();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick("Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    click(screen.getByText("Delete"));

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
      mockApi(zeroSchedulesMainContract.list, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(200, { schedules: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/agents/my-agent?tab=schedule",
    });

    await waitFor(() => {
      expect(screen.getByTestId("schedule-tab-skeleton")).toBeInTheDocument();
    });

    hangDeferred.resolve();
  });
});

describe("zero-schedule-tab - error state", () => {
  it("displays error message when schedule fetch fails (SCHED-D-044)", async () => {
    mockBaseAPIs([]);
    server.use(
      mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
        return respond(401, {
          error: {
            message: "Failed to load schedules",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }),
    );

    await navigateToScheduleTab();

    await waitFor(() => {
      expect(screen.getByText("Failed to load schedules")).toBeInTheDocument();
    });
  });
});
