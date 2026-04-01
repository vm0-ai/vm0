import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function createMockSchedules() {
  return [
    {
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
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
    },
    {
      id: "f0000001-0000-4000-a000-000000000002",
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName: "Zero",
      name: "check-inbox",
      triggerType: "loop",
      cronExpression: null,
      atTime: null,
      intervalSeconds: 900,
      timezone: "UTC",
      prompt: "Check inbox for urgent items",
      description: null,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-03-02T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
      userId: "test-user-123",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
    },
    {
      id: "f0000001-0000-4000-a000-000000000003",
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName: "Zero",
      name: "disabled-schedule",
      triggerType: "cron",
      cronExpression: "0 12 * * *",
      atTime: null,
      intervalSeconds: null,
      timezone: "UTC",
      prompt: "Disabled daily task",
      description: null,
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-02-28T00:00:00Z",
      updatedAt: "2026-02-28T00:00:00Z",
      userId: "test-user-123",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
    },
  ];
}

function mockScheduleAPI(schedules = createMockSchedules()) {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderSchedulePage() {
  await setupPage({ context, path: "/schedule" });
}

/** Open the dropdown menu for a schedule row, then click a menu item. */
async function openMenuAndClick(
  user: ReturnType<typeof userEvent.setup>,
  timeLabel: string,
  action: "Edit" | "Delete" | "Run now",
) {
  const menuTrigger = screen.getByRole("button", {
    name: `More actions for ${timeLabel}`,
  });
  await user.click(menuTrigger);
  await waitFor(() => {
    expect(screen.getByRole("menuitem", { name: action })).toBeInTheDocument();
  });
  await user.click(screen.getByRole("menuitem", { name: action }));
}

describe("zero schedule page - agent labels", () => {
  it("should display agent displayName for schedules belonging to sub-agents", async () => {
    // Mock team API with a sub-agent that has a displayName
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          {
            id: "c0000000-0000-4000-a000-000000000001",
            displayName: "Zero",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v1",
            updatedAt: "2024-01-01T00:00:00Z",
            userId: "test-user-123",
            appendSystemPrompt: null,
            vars: null,
            secretNames: null,
            artifactName: null,
            artifactVersion: null,
            volumeVersions: null,
            retryStartedAt: null,
            consecutiveFailures: 0,
          },
          {
            id: "e0000000-0000-4000-a000-000000000002",
            displayName: "Research Agent",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v2",
            updatedAt: "2024-01-02T00:00:00Z",
            userId: "test-user-123",
            appendSystemPrompt: null,
            vars: null,
            secretNames: null,
            artifactName: null,
            artifactVersion: null,
            volumeVersions: null,
            retryStartedAt: null,
            consecutiveFailures: 0,
          },
        ]);
      }),
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [
            {
              ...createMockSchedules()[0],
              agentId: "e0000000-0000-4000-a000-000000000002",
              displayName: "Research Agent",
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );
    await renderSchedulePage();

    // The agent column should show "Research Agent" (from schedule displayName)
    await waitFor(() => {
      expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    });
  });

  it("should fall back to agent id when displayName is null", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          {
            id: "c0000000-0000-4000-a000-000000000001",
            displayName: null,
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v1",
            updatedAt: "2024-01-01T00:00:00Z",
            userId: "test-user-123",
            appendSystemPrompt: null,
            vars: null,
            secretNames: null,
            artifactName: null,
            artifactVersion: null,
            volumeVersions: null,
            retryStartedAt: null,
            consecutiveFailures: 0,
          },
          {
            id: "e0000000-0000-4000-a000-000000000003",
            displayName: null,
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v2",
            updatedAt: "2024-01-02T00:00:00Z",
            userId: "test-user-123",
            appendSystemPrompt: null,
            vars: null,
            secretNames: null,
            artifactName: null,
            artifactVersion: null,
            volumeVersions: null,
            retryStartedAt: null,
            consecutiveFailures: 0,
          },
        ]);
      }),
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [
            {
              ...createMockSchedules()[0],
              agentId: "e0000000-0000-4000-a000-000000000003",
              displayName: null,
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );
    await renderSchedulePage();

    // Falls back to raw agent id when displayName is null
    await waitFor(() => {
      expect(
        screen.getAllByText("e0000000-0000-4000-a000-000000000003")[0],
      ).toBeInTheDocument();
    });
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
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
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
    const menus = screen.getAllByRole("button", { name: /More actions for/ });
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
      screen.getByRole("link", {
        name: /Open schedule Summarize yesterday's threads/i,
      }),
    ).toBeInTheDocument();
  });

  it("should expose Run now, Edit, and Delete in the row menu", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });
    const menuTrigger = screen.getByRole("button", {
      name: "More actions for Every weekday at 9:00 AM",
    });
    await user.click(menuTrigger);
    await waitFor(() => {
      expect(
        screen.getByRole("menuitem", { name: /Run now/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: "Edit" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: "Delete" }),
      ).toBeInTheDocument();
    });
  });
});

describe("zero schedule page - create dialog", () => {
  it("should open create dialog when Add schedule is clicked", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    // Wait for the schedule list to render (non-empty so only one Add schedule in header)
    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });

  it("should save a new schedule via API", async () => {
    const user = userEvent.setup();
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          schedule: { id: "schedule-new" },
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    // Wait for schedules to render
    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    // Fill in prompt
    const promptInput = screen.getByLabelText("Prompt");
    await user.clear(promptInput);
    await user.type(promptInput, "Daily standup summary");

    // Click Create
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("prompt", "Daily standup summary");
  });
});

describe("zero schedule page - toggle enabled", () => {
  it("should send PATCH request when toggling schedule enabled state", async () => {
    const user = userEvent.setup();
    let capturedAction: string | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules/:name/:action", ({ params }) => {
        capturedAction = params["action"] as string;
        return HttpResponse.json(createMockSchedules()[0]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
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
    await user.click(toggleSwitch);

    await waitFor(() => {
      expect(capturedAction).toBe("disable");
    });
  });
});

describe("zero schedule page - delete confirmation", () => {
  it("should show confirmation dialog when delete button is clicked", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
    expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("should close dialog without deleting when Cancel is clicked", async () => {
    const user = userEvent.setup();
    let deleteCalled = false;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.delete("*/api/zero/schedules/:name", () => {
        deleteCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deleteCalled).toBeFalsy();
  });

  it("should call delete API when Delete is confirmed", async () => {
    const user = userEvent.setup();
    let deletedName: string | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.delete("*/api/zero/schedules/:name", ({ params }) => {
        deletedName = params["name"] as string;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deletedName).toBe("morning-briefing");
    });
  });

  it("should close dialog immediately after Delete is confirmed", async () => {
    const user = userEvent.setup();
    let deletedName: string | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.delete("*/api/zero/schedules/:name", ({ params }) => {
        deletedName = params["name"] as string;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await openMenuAndClick(user, "Every weekday at 9:00 AM", "Delete");

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    // Dialog should close immediately
    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deletedName).toBe("morning-briefing");
  });
});

describe("zero schedule page - create dialog confirm close", () => {
  it("should show confirm overlay when Cancel is clicked with prompt text", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    const promptInput = screen.getByLabelText("Prompt");
    await user.clear(promptInput);
    await user.type(promptInput, "Some new task");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });
  });

  it("should close create dialog directly when Cancel is clicked without changes", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

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
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
  });

  it("should disable Create button when prompt is empty", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("should enable Create button when prompt is filled", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await user.clear(screen.getByLabelText("Prompt"));
    await user.type(screen.getByLabelText("Prompt"), "Do something");

    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("should show save error in dialog", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
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
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await user.clear(screen.getByLabelText("Prompt"));
    await user.type(screen.getByLabelText("Prompt"), "Some task");

    await user.click(screen.getByRole("button", { name: "Create" }));

    // Dialog should stay open with error message
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
      expect(screen.getByRole("tab", { name: /List/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: /Calendar/i })).toBeInTheDocument();
  });

  it("should switch to calendar view when Calendar tab is clicked", async () => {
    const user = userEvent.setup();
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Calendar/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("tab", { name: /Calendar/i }));

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });
});

describe("zero schedule page - create dialog timezone default", () => {
  it("should use preference timezone in submitted request when set", async () => {
    const user = userEvent.setup();
    setMockUserPreferences({ timezone: "Asia/Tokyo" });

    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ schedule: { id: "schedule-new" } });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({ context, path: "/schedule" });

    // Wait for schedules to render (preferences will have loaded by then)
    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await user.clear(screen.getByLabelText("Prompt"));
    await user.type(screen.getByLabelText("Prompt"), "Daily task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("timezone", "Asia/Tokyo");
  });

  it("should fall back to local timezone in submitted request when preference not set", async () => {
    const user = userEvent.setup();
    // timezone is null by default (reset via resetAllMockHandlers in afterEach)
    const localTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ schedule: { id: "schedule-new" } });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({ context, path: "/schedule" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Add schedule/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    await user.clear(screen.getByLabelText("Prompt"));
    await user.type(screen.getByLabelText("Prompt"), "Daily task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("timezone", localTimezone);
  });
});
