import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  type ScheduleResponse,
} from "@vm0/core";

const context = testContext();

function createMockSchedules(): ScheduleResponse[] {
  return [
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000001",
      displayName: "Zero",
      name: "morning-briefing",
      cronExpression: "0 9 * * 1-5",
      prompt: "Summarize yesterday's threads",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    }),
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000002",
      displayName: "Zero",
      name: "check-inbox",
      triggerType: "loop",
      cronExpression: null,
      intervalSeconds: 900,
      prompt: "Check inbox for urgent items",
      createdAt: "2026-03-02T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
    }),
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000003",
      displayName: "Zero",
      name: "disabled-schedule",
      cronExpression: "0 12 * * *",
      prompt: "Disabled daily task",
      enabled: false,
      createdAt: "2026-02-28T00:00:00Z",
      updatedAt: "2026-02-28T00:00:00Z",
    }),
  ];
}

function mockDeployResponse(): {
  schedule: ScheduleResponse;
  created: boolean;
} {
  return {
    schedule: createMockScheduleResponse({
      id: "d0000001-0000-4000-a000-000000000001",
      displayName: "Zero",
      name: "new-schedule",
      cronExpression: "0 9 * * *",
      prompt: "Daily standup summary",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    }),
    created: true,
  };
}

function mockScheduleAPI(schedules = createMockSchedules()) {
  setMockSchedules(schedules);
}

function renderSchedulePage() {
  detachedSetupPage({ context, path: "/schedules" });
}

/** Open the dropdown menu for a schedule row, then click a menu item. */
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
      screen.getAllByRole("menuitem").find((el) => {
        return el.textContent?.includes(action);
      }),
    ).toBeDefined();
  });
  click(
    screen.getAllByRole("menuitem").find((el) => {
      return el.textContent?.includes(action);
    })!,
  );
}

describe("zero schedule page - agent labels", () => {
  it("should display agent displayName for schedules belonging to sub-agents", async () => {
    // Mock team API with a sub-agent that has a displayName
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "v1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "e0000000-0000-4000-a000-000000000002",
        displayName: "Research Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "v2",
        updatedAt: "2024-01-02T00:00:00Z",
      },
    ]);
    setMockSchedules([
      createMockScheduleResponse({
        agentId: "e0000000-0000-4000-a000-000000000002",
        displayName: "Research Agent",
        name: "morning-briefing",
        cronExpression: "0 9 * * 1-5",
        prompt: "Summarize yesterday's threads",
      }),
    ]);
    await renderSchedulePage();

    // The agent column should show "Research Agent" (from schedule displayName)
    await waitFor(() => {
      expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    });
  });

  it("should fall back to agent id when displayName is null", async () => {
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "v1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "e0000000-0000-4000-a000-000000000003",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "v2",
        updatedAt: "2024-01-02T00:00:00Z",
      },
    ]);
    setMockSchedules([
      createMockScheduleResponse({
        agentId: "e0000000-0000-4000-a000-000000000003",
        displayName: null,
        name: "morning-briefing",
        cronExpression: "0 9 * * 1-5",
        prompt: "Summarize yesterday's threads",
      }),
    ]);
    await renderSchedulePage();

    // Falls back to raw agent id when displayName is null
    await waitFor(() => {
      expect(
        screen.getAllByText("e0000000-0000-4000-a000-000000000003")[0],
      ).toBeInTheDocument();
    });
  });

  it("should only show schedules belonging to the filtered agent (SCHED-D-001)", async () => {
    setMockSchedules([
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000099",
        displayName: "Zero",
        name: "alpha-only-task",
        cronExpression: "0 9 * * 1-5",
        prompt: "Alpha only task",
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000098",
        agentId: "c0000000-0000-4000-a000-000000000002",
        displayName: "Beta Agent",
        name: "beta-only-task",
        cronExpression: "0 10 * * 1-5",
        prompt: "Beta only task",
        createdAt: "2026-03-02T00:00:00Z",
        updatedAt: "2026-03-02T00:00:00Z",
      }),
    ]);
    await renderSchedulePage();
    await waitFor(() => {
      expect(
        screen.getAllByLabelText(/Open schedule Alpha only task/)[0],
      ).toBeInTheDocument();
    });
    expect(
      screen.getAllByLabelText(/Open schedule Beta only task/)[0],
    ).toBeInTheDocument();
    expect(
      screen.queryAllByLabelText(/Open schedule Gamma only task/),
    ).toHaveLength(0);
  });

  it("should display schedules from multiple agents with their respective agent labels (SCHED-D-006)", async () => {
    setMockSchedules([
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000011",
        agentId: "c0000000-0000-4000-a000-000000000011",
        displayName: "Alpha Bot",
        name: "alpha-schedule",
        cronExpression: "0 9 * * 1-5",
        prompt: "Alpha daily standup",
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000022",
        agentId: "c0000000-0000-4000-a000-000000000022",
        displayName: "Beta Bot",
        name: "beta-schedule",
        triggerType: "loop",
        cronExpression: null,
        intervalSeconds: 1800,
        prompt: "Beta monitoring check",
        createdAt: "2026-03-02T00:00:00Z",
        updatedAt: "2026-03-02T00:00:00Z",
      }),
    ]);
    await renderSchedulePage();
    await waitFor(() => {
      expect(
        screen.getAllByLabelText(/Open schedule Alpha daily standup/)[0],
      ).toBeInTheDocument();
    });
    expect(
      screen.getAllByLabelText(/Open schedule Beta monitoring check/)[0],
    ).toBeInTheDocument();
    // Two distinct schedules from two distinct agents should both be rendered
    expect(
      screen.getAllByRole("link").filter((el) => {
        return /Open schedule/.test(el.getAttribute("aria-label") ?? "");
      }),
    ).toHaveLength(2);
  });
});

describe("zero schedule page - list view", () => {
  it("should render schedule entries with time and prompt", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    expect(
      screen.getAllByText("Check inbox for urgent items")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Every weekday at 9:00 AM/)[0],
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Every 15 minutes/)[0]).toBeInTheDocument();
  });

  it("should render page title and subtitle", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Automated tasks scheduled across all agents in your workspace.",
      ),
    ).toBeInTheDocument();
  });

  it("should show empty state when no schedules exist", async () => {
    mockScheduleAPI([]);
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Set up a schedule and your agents will handle the rest.",
      ),
    ).toBeInTheDocument();
  });

  it("should have Add schedule button in header", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Add schedule/i)).toBeInTheDocument();
    });
  });

  it("should show a row action menu for each schedule entry", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });
    const menus = screen.getAllByRole("button").filter((el) => {
      return /More actions for/.test(el.getAttribute("aria-label") ?? "");
    });
    expect(menus).toHaveLength(3);
  });

  it("should make each schedule row clickable to detail page", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });
    expect(
      screen.getAllByLabelText(
        /Open schedule Summarize yesterday's threads/i,
      )[0],
    ).toBeInTheDocument();
  });

  it("should expose Run now, Edit, and Delete in the row menu", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });
    const menuTrigger = screen.getAllByLabelText(
      "More actions for Every weekday at 9:00 AM",
    )[0];
    click(menuTrigger);
    await waitFor(() => {
      expect(screen.getByText(/Run now/)).toBeInTheDocument();
      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
  });
});

describe("zero schedule page - create dialog", () => {
  it("should open create dialog when Add schedule is clicked", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    // Wait for the schedule list to render (non-empty so only one Add schedule in header)
    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });

  it("should save a new schedule via API", async () => {
    let capturedPrompt: string | null = null;

    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
        capturedPrompt = body.prompt;
        return respond(201, mockDeployResponse());
      }),
    );

    await renderSchedulePage();

    // Wait for schedules to render
    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    // Fill in prompt
    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "Daily standup summary");

    // Click Create
    click(screen.getByText("Create"));

    await waitFor(() => {
      expect(capturedPrompt).toBeTruthy();
    });
    expect(capturedPrompt).toBe("Daily standup summary");
  });
});

describe("zero schedule page - toggle enabled", () => {
  it("should send PATCH request when toggling schedule enabled state", async () => {
    let capturedAction: string | null = null;

    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesEnableContract.disable, ({ respond }) => {
        capturedAction = "disable";
        return respond(200, createMockSchedules()[0]);
      }),
      mockApi(zeroSchedulesEnableContract.enable, ({ respond }) => {
        capturedAction = "enable";
        return respond(200, createMockSchedules()[0]);
      }),
    );

    await renderSchedulePage();

    // Wait for the schedule list to render
    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Disable Every weekday at 9:00 AM")[0],
      ).toBeInTheDocument();
    });

    // Toggle the first schedule's enabled switch
    const toggleSwitch = screen.getAllByLabelText(
      "Disable Every weekday at 9:00 AM",
    )[0];
    click(toggleSwitch);

    await waitFor(() => {
      expect(capturedAction).toBe("disable");
    });
  });
});

describe("zero schedule page - delete confirmation", () => {
  it("should show confirmation dialog when delete button is clicked", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick("Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
    expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("should close dialog without deleting when Cancel is clicked", async () => {
    let deleteCalled = false;

    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ respond }) => {
        deleteCalled = true;
        return respond(204);
      }),
    );

    await renderSchedulePage();

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
  });

  it("should call delete API when Delete is confirmed", async () => {
    let deletedName: string | null = null;

    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ params, respond }) => {
        deletedName = params.name;
        return respond(204);
      }),
    );

    await renderSchedulePage();

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

  it("should show Deleting… and disable buttons while delete API is pending", async () => {
    let resolveDelete: (() => void) | null = null;

    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ respond }) => {
        return new Promise<ReturnType<typeof respond>>((resolve) => {
          resolveDelete = () => {
            return resolve(respond(204));
          };
        });
      }),
    );

    await renderSchedulePage();

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

    // Dialog stays open with loading state
    await waitFor(() => {
      expect(screen.getByText("Deleting…")).toBeInTheDocument();
    });
    expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeDisabled();
    expect(screen.getByText("Deleting…")).toBeDisabled();

    resolveDelete!();

    // Dialog closes after completion
    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
  });

  it("should close dialog immediately after Delete is confirmed", async () => {
    let deletedName: string | null = null;

    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesByNameContract.delete, ({ params, respond }) => {
        deletedName = params.name;
        return respond(204);
      }),
    );

    await renderSchedulePage();

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

    // Dialog should close immediately
    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deletedName).toBe("morning-briefing");
  });
});

describe("zero schedule page - create dialog confirm close", () => {
  it("should show confirm overlay when Cancel is clicked with prompt text", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Add schedule/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "Some new task");

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });
  });

  it("should close create dialog directly when Cancel is clicked without changes", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Add schedule/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Add schedule" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();
  });
});

describe("zero schedule page - schedule dialog fields", () => {
  it("should show agent selector in create dialog", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Add schedule/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
  });

  it("should disable Create button when prompt is empty", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Add schedule/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Create")).toBeDisabled();
  });

  it("should enable Create button when prompt is filled", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Add schedule/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Prompt"), "Do something");

    expect(screen.getByText("Create")).toBeEnabled();
  });

  it("should surface save error via toast and keep dialog open", async () => {
    setMockSchedules(createMockSchedules());
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

    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Add schedule/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Prompt"), "Some task");

    click(screen.getByText("Create"));

    await waitFor(() => {
      expect(screen.getByText(/Schedule limit reached/)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });
});

describe("zero schedule page - view modes", () => {
  it("should render list and calendar view tabs", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/List/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Calendar/i)).toBeInTheDocument();
  });

  it("should switch to calendar view when Calendar tab is clicked", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(screen.getByText(/Calendar/i)).toBeInTheDocument();
    });

    click(screen.getByText(/Calendar/i));

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });
});

describe("zero schedule page - loading state", () => {
  it("should show skeleton while schedules are being fetched (SCHED-D-004)", async () => {
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

describe("zero schedule page - create dialog timezone default", () => {
  it("should use preference timezone in submitted request when set", async () => {
    setMockUserPreferences({ timezone: "Asia/Tokyo" });

    let capturedTimezone: string | null = null;
    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
        capturedTimezone = body.timezone;
        return respond(201, mockDeployResponse());
      }),
    );

    detachedSetupPage({ context, path: "/schedules" });

    // Wait for schedules to render (preferences will have loaded by then)
    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Prompt"), "Daily task");
    click(screen.getByText("Create"));

    await waitFor(() => {
      expect(capturedTimezone).toBeTruthy();
    });
    expect(capturedTimezone).toBe("Asia/Tokyo");
  });

  it("should fall back to local timezone in submitted request when preference not set", async () => {
    // timezone is null by default (reset via resetAllMockHandlers in afterEach)
    const localTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

    let capturedTimezone: string | null = null;
    setMockSchedules(createMockSchedules());
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
        capturedTimezone = body.timezone;
        return respond(201, mockDeployResponse());
      }),
    );

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    click(screen.getByText(/Add schedule/i));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Prompt"), "Daily task");
    click(screen.getByText("Create"));

    await waitFor(() => {
      expect(capturedTimezone).toBeTruthy();
    });
    expect(capturedTimezone).toBe(localTimezone);
  });
});
