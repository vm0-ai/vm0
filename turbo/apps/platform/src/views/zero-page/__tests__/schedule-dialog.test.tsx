import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function mockScheduleBase() {
  return {
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
  };
}

function mockScheduleForList() {
  return {
    ...mockScheduleBase(),
    id: SCHEDULE_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "morning-task",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Existing prompt text",
    description: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function mockDeployResponse() {
  return {
    schedule: {
      ...mockScheduleBase(),
      id: "d0000001-0000-4000-a000-000000000001",
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName: "Zero",
      name: "new-schedule",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      atTime: null,
      intervalSeconds: null,
      timezone: "UTC",
      prompt: "Daily standup summary",
      description: null,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    },
    created: true,
  };
}

function mockCreateModeAPIs() {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [mockScheduleForList()] });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  mockCreateModeAPIs();
  detachedSetupPage({ context, path: "/schedules" });
  await waitFor(() => {
    expect(screen.getByText(/Add schedule/i)).not.toBeDisabled();
  });
  await user.click(screen.getByText(/Add schedule/i));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });
}

function mockEditModeAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-owner-id",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: null,
        avatarUrl: null,
        connectors: [],
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/my-agent/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [mockScheduleForList()] });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function openEditDialog(user: ReturnType<typeof userEvent.setup>) {
  mockEditModeAPIs();
  // Navigate with ?tab=schedule so resetActiveTab$ picks up the schedule tab from the URL.
  detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });
  await waitFor(() => {
    expect(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    ).toBeInTheDocument();
  });
  await user.click(
    screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
  );
  await waitFor(() => {
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });
  await user.click(screen.getByText("Edit"));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Edit schedule" }),
    ).toBeInTheDocument();
  });
}

async function switchFrequency(
  user: ReturnType<typeof userEvent.setup>,
  freqLabel: string,
) {
  const freqTrigger = screen.getByRole("combobox", { name: "Time" });
  await user.click(freqTrigger);
  await waitFor(() => {
    expect(screen.getByRole("option", { name: freqLabel })).toBeInTheDocument();
  });
  await user.click(screen.getByRole("option", { name: freqLabel }));
}

describe("schedule dialog - form title (SCHED-D-046)", () => {
  it("shows 'Add schedule' in create mode", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });

  it("shows 'Edit schedule' in edit mode", async () => {
    const user = userEvent.setup();
    await openEditDialog(user);
    expect(
      screen.getByRole("heading", { name: "Edit schedule" }),
    ).toBeInTheDocument();
  });
});

describe("schedule dialog - save error (SCHED-D-047)", () => {
  it("surfaces save failure via toast and keeps dialog open", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/zero/schedules", () => {
        return HttpResponse.json({ error: "Server error" }, { status: 500 });
      }),
    );
    await openCreateDialog(user);
    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "My task");
    await user.click(screen.getByText("Create"));
    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("schedule dialog - loading state (SCHED-D-048)", () => {
  it("shows loading indicator on save button while saving", async () => {
    const hangDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      http.post("*/api/zero/schedules", async () => {
        await hangDeferred.promise;
        return HttpResponse.json(mockDeployResponse());
      }),
    );
    const user = userEvent.setup();
    await openCreateDialog(user);
    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "My task");
    await user.click(screen.getByText("Create"));
    await waitFor(() => {
      expect(screen.getByText("Creating\u2026")).toBeInTheDocument();
    });
    hangDeferred.resolve();
  });
});

describe("schedule dialog - agent selector renders (SCHED-D-049)", () => {
  it("renders agent selector dropdown in create mode", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeInTheDocument();
  });
});

describe("schedule dialog - unsaved confirmation overlay (SCHED-D-050)", () => {
  it("renders confirm overlay when form is dirty and dialog is closed", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Prompt"), "Some text");
    await user.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
  });
});

describe("schedule dialog - agent selection (SCHED-D-051)", () => {
  it("sets selected agent when a different agent is chosen", async () => {
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
    );
    const user = userEvent.setup();
    await openCreateDialog(user);
    const agentTrigger = screen.getByRole("combobox", { name: "Agent" });
    await user.click(agentTrigger);
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: "Research Agent" }));
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
        "Research Agent",
      );
    });
  });
});

describe("schedule dialog - frequency select (SCHED-D-054)", () => {
  it("shows date picker when frequency is changed to Once", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await switchFrequency(user, "Once");
    await waitFor(() => {
      expect(screen.getByLabelText("Date")).toBeInTheDocument();
    });
  });
});

describe("schedule dialog - loop interval (SCHED-D-055)", () => {
  it("updates loop interval when a new value is selected", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await switchFrequency(user, "Loop");
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Every" }),
      ).toBeInTheDocument();
    });
    const loopTrigger = screen.getByRole("combobox", { name: "Every" });
    await user.click(loopTrigger);
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "30 minutes" }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: "30 minutes" }));
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Every" })).toHaveTextContent(
        "30 minutes",
      );
    });
  });
});

describe("schedule dialog - day of week (SCHED-D-057)", () => {
  it("toggles day selection when a day button is clicked", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await switchFrequency(user, "Every week");
    await waitFor(() => {
      expect(screen.getByText("Tue")).toBeInTheDocument();
    });
    const tueBefore = screen.getByText("Tue");
    expect(tueBefore).toHaveAttribute("aria-pressed", "false");
    await user.click(tueBefore);
    await waitFor(() => {
      expect(screen.getByText("Tue")).toHaveAttribute("aria-pressed", "true");
    });
  });
});

describe("schedule dialog - day of month (SCHED-D-058)", () => {
  it("updates day of month when selected", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await switchFrequency(user, "Every month");
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Day of month" }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("combobox", { name: "Day of month" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "15" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: "15" }));
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Day of month" }),
      ).toHaveTextContent("15");
    });
  });
});

describe("schedule dialog - hour select (SCHED-D-059)", () => {
  it("updates hour when a new hour is selected", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    // Default freq is every_day which shows hour/minute selects
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Hour" }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("combobox", { name: "Hour" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "14" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: "14" }));
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Hour" })).toHaveTextContent(
        "14",
      );
    });
  });
});

describe("schedule dialog - minute select (SCHED-D-060)", () => {
  it("updates minute when a new minute is selected", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    // Default freq is every_day which shows hour/minute selects
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Minute" }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("combobox", { name: "Minute" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "30" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: "30" }));
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Minute" }),
      ).toHaveTextContent("30");
    });
  });
});

describe("schedule dialog - timezone select (SCHED-D-061)", () => {
  it("renders timezone select and reflects selection change", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    // Default freq is every_day which shows timezone select.
    const tzTrigger = screen.getByRole("combobox", { name: "Timezone" });
    expect(tzTrigger).toBeInTheDocument();
    // Open via keyboard — pointer-events:none on body (set by the Radix Dialog) prevents
    // click-based interactions with portalled SelectContent. Keyboard nav bypasses this.
    // The test environment default timezone is "UTC" (prepended to the COMMON_TIMEZONES
    // list). Two ArrowDown presses navigate past "UTC" (index 0) and "Etc/UTC" (index 1)
    // to "America/New_York" = "Eastern Time (ET)" (index 2).
    tzTrigger.focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Timezone" }),
      ).toHaveTextContent("Eastern Time (ET)");
    });
  });
});

describe("schedule dialog - cancel button (SCHED-D-062)", () => {
  it("closes dialog without saving when Cancel is clicked on clean form", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await user.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Add schedule" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("schedule dialog - save button (SCHED-D-063)", () => {
  it("submits form and closes dialog when Create is clicked", async () => {
    let captured = false;
    server.use(
      http.post("*/api/zero/schedules", () => {
        captured = true;
        return HttpResponse.json(mockDeployResponse());
      }),
    );
    const user = userEvent.setup();
    await openCreateDialog(user);
    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "My task");
    await user.click(screen.getByText("Create"));
    await waitFor(() => {
      expect(captured).toBeTruthy();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Add schedule" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("schedule dialog - close button (SCHED-D-064)", () => {
  it("closes dialog when Close button is clicked on clean form", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    // The dialog has a custom Close button with aria-label="Close" (the X icon).
    // Use getAllByLabelText and pick the first one (the custom X button).
    await user.click(screen.getAllByLabelText("Close")[0]);
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Add schedule" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("schedule dialog - unsaved discard (SCHED-D-065)", () => {
  it("discards changes and closes dialog when Discard Changes is clicked", async () => {
    // The ConfirmCloseOverlay renders via createPortal outside the Radix Dialog tree.
    // Radix Dialog sets pointer-events:none on the body, so bypass that check.
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Prompt"), "Something");
    await user.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Discard Changes"));
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Add schedule" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("schedule dialog - unsaved continue (SCHED-D-066)", () => {
  it("closes overlay and shows form when Continue Editing is clicked", async () => {
    // The ConfirmCloseOverlay renders via createPortal outside the Radix Dialog tree.
    // Radix Dialog sets pointer-events:none on the body, so bypass that check.
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Prompt"), "Something");
    await user.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Continue Editing"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });
  });
});

describe("schedule dialog - ESC with unsaved changes (SCHED-D-067)", () => {
  it("shows confirm overlay when ESC is pressed with a dirty form", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Prompt"), "Some text");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    // Dialog must remain open behind the confirm overlay.
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });

  it("closes dialog directly when ESC is pressed on a clean form", async () => {
    const user = userEvent.setup();
    await openCreateDialog(user);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Add schedule" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
