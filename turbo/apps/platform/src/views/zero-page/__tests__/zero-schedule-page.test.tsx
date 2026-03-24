import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function createMockSchedules() {
  return [
    {
      id: "sched-1",
      zeroAgentId: "mock-compose-id",
      agentName: "zero",
      orgSlug: "test",
      name: "morning-briefing",
      triggerType: "cron",
      cronExpression: "0 9 * * 1-5",
      atTime: null,
      intervalSeconds: null,
      timezone: "UTC",
      prompt: "Summarize yesterday's threads",
      description: null,
      enabled: true,
      notifyEmail: false,
      notifySlack: false,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
    {
      id: "sched-2",
      zeroAgentId: "mock-compose-id",
      agentName: "zero",
      orgSlug: "test",
      name: "check-inbox",
      triggerType: "loop",
      cronExpression: null,
      atTime: null,
      intervalSeconds: 900,
      timezone: "UTC",
      prompt: "Check inbox for urgent items",
      description: null,
      enabled: true,
      notifyEmail: false,
      notifySlack: false,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-03-02T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
    },
    {
      id: "sched-disabled",
      zeroAgentId: "mock-compose-id",
      agentName: "zero",
      orgSlug: "test",
      name: "disabled-schedule",
      triggerType: "cron",
      cronExpression: "0 12 * * *",
      atTime: null,
      intervalSeconds: null,
      timezone: "UTC",
      prompt: "Disabled daily task",
      description: null,
      enabled: false,
      notifyEmail: false,
      notifySlack: false,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-02-28T00:00:00Z",
      updatedAt: "2026-02-28T00:00:00Z",
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

describe("zero schedule page - list view", () => {
  it("should render schedule entries with time and prompt", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByText("Summarize yesterday's threads"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("Check inbox for urgent items"),
    ).toBeInTheDocument();
    expect(screen.getByText("Every weekday at 9:00 AM")).toBeInTheDocument();
    expect(screen.getByText("Every 15 minutes")).toBeInTheDocument();
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
      expect(screen.getByText("Nothing on the calendar")).toBeInTheDocument();
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

  it("should show edit buttons for each schedule entry", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Edit Every 15 minutes")).toBeInTheDocument();
  });

  it("should show delete buttons for named schedule entries", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Delete Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
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
        screen.getByText("Summarize yesterday's threads"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });

  it("should save a new schedule via API", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ success: true });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    // Wait for schedules to render
    await waitFor(() => {
      expect(
        screen.getByText("Summarize yesterday's threads"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    // Fill in prompt
    const promptInput = screen.getByLabelText("Prompt");
    fireEvent.change(promptInput, {
      target: { value: "Daily standup summary" },
    });

    // Click Create
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("prompt", "Daily standup summary");
  });
});

describe("zero schedule page - toggle enabled", () => {
  it("should send PATCH request when toggling schedule enabled state", async () => {
    let capturedAction: string | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules/:name/:action", ({ params }) => {
        capturedAction = params["action"] as string;
        return HttpResponse.json({ success: true });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    // Wait for the schedule list to render
    await waitFor(() => {
      expect(
        screen.getByLabelText("Disable Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    // Toggle the first schedule's enabled switch
    const toggleSwitch = screen.getByLabelText(
      "Disable Every weekday at 9:00 AM",
    );
    fireEvent.click(toggleSwitch);

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
        screen.getByLabelText("Delete Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Delete Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
    expect(screen.getByText("morning-briefing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("should close dialog without deleting when Cancel is clicked", async () => {
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
        screen.getByLabelText("Delete Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Delete Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });
    expect(deleteCalled).toBeFalsy();
  });

  it("should call delete API when Delete is confirmed", async () => {
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
        screen.getByLabelText("Delete Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Delete Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deletedName).toBe("morning-briefing");
    });
  });
});

describe("zero schedule page - edit dialog confirm close", () => {
  it("should show confirm overlay when Cancel is clicked with unsaved changes", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    // Wait for schedule list
    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    // Open edit dialog
    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    // Modify the prompt
    const promptInput = screen.getByLabelText("Prompt");
    fireEvent.change(promptInput, {
      target: { value: "Changed prompt text" },
    });

    // Click Cancel
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Confirm overlay should appear
    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "Continue Editing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard Changes" }),
    ).toBeInTheDocument();
  });

  it("should show confirm overlay when ESC key is pressed with unsaved changes", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    const promptInput = screen.getByLabelText("Prompt");
    fireEvent.change(promptInput, {
      target: { value: "Changed prompt text" },
    });

    // Press ESC key on the dialog content
    const dialogContent = screen
      .getByText("Edit schedule")
      .closest("[role=dialog]");
    fireEvent.keyDown(dialogContent!, { key: "Escape" });

    // Confirm overlay should appear
    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });
  });

  it("should close dialog directly when Cancel is clicked without changes", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    // Click Cancel without making changes
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Dialog should close immediately
    await waitFor(() => {
      expect(screen.queryByText("Edit schedule")).not.toBeInTheDocument();
    });
    // No confirm overlay
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();
  });

  it("should return to editing when Continue Editing is clicked", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    const promptInput = screen.getByLabelText("Prompt");
    fireEvent.change(promptInput, {
      target: { value: "Changed prompt text" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    // Click Continue Editing
    fireEvent.click(screen.getByRole("button", { name: "Continue Editing" }));

    // Confirm overlay dismissed, dialog still open with edits preserved
    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Edit schedule")).toBeInTheDocument();
  });

  it("should close dialog when Discard Changes is clicked", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    const promptInput = screen.getByLabelText("Prompt");
    fireEvent.change(promptInput, {
      target: { value: "Changed prompt text" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    // Click Discard Changes
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));

    // Dialog should close
    await waitFor(() => {
      expect(screen.queryByText("Edit schedule")).not.toBeInTheDocument();
    });
  });
});

describe("zero schedule page - create dialog confirm close", () => {
  it("should show confirm overlay when Cancel is clicked with prompt text", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    const promptInput = screen.getByLabelText("Prompt");
    fireEvent.change(promptInput, {
      target: { value: "Some new task" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });
  });

  it("should close create dialog directly when Cancel is clicked without changes", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

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
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
  });

  it("should show notification toggles in create dialog", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
  });

  it("should show notification toggles in edit dialog", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
  });

  it("should disable Create button when prompt is empty", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("should enable Create button when prompt is filled", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Add schedule/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Do something" },
    });

    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("should include notification values in save request", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ success: true });
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

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    // Fill prompt
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Test with notifications" },
    });

    // Toggle email notification on
    const emailRow = screen.getByText("Email").parentElement!;
    const emailSwitch = within(emailRow).getByRole("switch");
    fireEvent.click(emailSwitch);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("notifyEmail", true);
    expect(capturedBody).toHaveProperty("notifySlack", false);
  });

  it("should show save error in dialog", async () => {
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({ schedules: createMockSchedules() });
      }),
      http.post("*/api/zero/schedules", () => {
        return HttpResponse.json(
          { error: { message: "Schedule limit reached" } },
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

    fireEvent.click(screen.getByRole("button", { name: /Add schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Some task" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // Dialog should stay open with error message
    await waitFor(() => {
      expect(screen.getByText(/Schedule limit reached/)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });

  it("should pre-fill prompt when editing an existing schedule", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    const promptInput = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(promptInput.value).toBe("Summarize yesterday's threads");
  });

  it("should not show agent selector in edit dialog", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
  });
});

describe("zero schedule page - timezone preservation", () => {
  it("should show stored timezone in edit dialog", async () => {
    const schedules = [{ ...createMockSchedules()[0], timezone: "Asia/Tokyo" }];
    mockScheduleAPI(schedules);
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    // The timezone selector trigger should show the stored timezone value
    const tzTrigger = document.getElementById("schedule-dialog-tz");
    expect(tzTrigger).toBeInTheDocument();
    expect(tzTrigger?.textContent).toContain("Asia/Tokyo");
  });

  it("should show non-preset timezone in edit dialog", async () => {
    const schedules = [
      { ...createMockSchedules()[0], timezone: "Africa/Nairobi" },
    ];
    mockScheduleAPI(schedules);
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    // The timezone selector trigger should show the non-preset timezone value
    const tzTrigger = document.getElementById("schedule-dialog-tz");
    expect(tzTrigger).toBeInTheDocument();
    expect(tzTrigger?.textContent).toContain("Africa/Nairobi");
  });

  it("should preserve timezone when saving edited schedule", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [{ ...createMockSchedules()[0], timezone: "Asia/Tokyo" }],
        });
      }),
      http.post("*/api/zero/schedules", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ success: true });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Edit Every weekday at 9:00 AM"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Edit Every weekday at 9:00 AM"));

    await waitFor(() => {
      expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    });

    // Change only the prompt, do NOT change timezone
    const promptInput = screen.getByLabelText("Prompt");
    fireEvent.change(promptInput, {
      target: { value: "Updated prompt text" },
    });

    // Click Save
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("timezone", "Asia/Tokyo");
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
    mockScheduleAPI();
    await renderSchedulePage();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Calendar/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Calendar/i }));

    await waitFor(() => {
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
  });
});
