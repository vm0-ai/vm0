import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  type ScheduleResponse,
  zeroSchedulesMainContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";

const context = testContext();
const mockApi = createMockApi(context);

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function mockScheduleForList(): ScheduleResponse {
  return createMockScheduleResponse({
    id: SCHEDULE_ID,
    displayName: "Zero",
    name: "morning-task",
    cronExpression: "0 9 * * 1-5",
    prompt: "Existing prompt text",
  });
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

function mockCreateModeAPIs() {
  setMockSchedules([mockScheduleForList()]);
}

async function openCreateDialog() {
  mockCreateModeAPIs();
  detachedSetupPage({ context, path: "/schedules" });
  await waitFor(() => {
    expect(screen.getByText(/Add schedule/i)).not.toBeDisabled();
  });
  click(screen.getByText(/Add schedule/i));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });
}

function mockEditModeAPIs() {
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
  ]);
  setMockSchedules([mockScheduleForList()]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "c0000000-0000-4000-a000-000000000001",
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

async function openEditDialog() {
  mockEditModeAPIs();
  // Navigate with ?tab=schedule so resetActiveTab$ picks up the schedule tab from the URL.
  detachedSetupPage({ context, path: "/agents/my-agent?tab=schedule" });
  await waitFor(() => {
    expect(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    ).toBeInTheDocument();
  });
  click(
    screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
  );
  await waitFor(() => {
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });
  click(screen.getByText("Edit"));
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Edit schedule" }),
    ).toBeInTheDocument();
  });
}

function getOpenListboxOption(text: string): HTMLElement {
  const listbox = screen.getByRole("listbox");
  return within(listbox).getByRole("option", { name: text });
}

async function switchFrequency(freqLabel: string) {
  const freqTrigger = screen.getByRole("combobox", { name: "Time" });
  click(freqTrigger);
  const option = await waitFor(() => {
    return getOpenListboxOption(freqLabel);
  });
  click(option);
}

describe("schedule dialog - form title (SCHED-D-046)", () => {
  it("shows 'Add schedule' in create mode", async () => {
    await openCreateDialog();
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });

  it("shows 'Edit schedule' in edit mode", async () => {
    await openEditDialog();
    expect(
      screen.getByRole("heading", { name: "Edit schedule" }),
    ).toBeInTheDocument();
  });
});

describe("schedule dialog - save error (SCHED-D-047)", () => {
  it("surfaces save failure via toast and keeps dialog open", async () => {
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
        return respond(400, {
          error: { message: "Server error", code: "BAD_REQUEST" },
        });
      }),
    );
    await openCreateDialog();
    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "My task");
    click(screen.getByText("Create"));
    await waitFor(() => {
      expect(screen.getByText(/Server error/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("schedule dialog - loading state (SCHED-D-048)", () => {
  it("shows loading indicator on save button while saving", async () => {
    const hangDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(201, mockDeployResponse());
      }),
    );
    await openCreateDialog();
    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "My task");
    click(screen.getByText("Create"));
    await waitFor(() => {
      expect(screen.getByText("Creating\u2026")).toBeInTheDocument();
    });
    hangDeferred.resolve();
  });
});

describe("schedule dialog - agent selector renders (SCHED-D-049)", () => {
  it("renders agent selector dropdown in create mode", async () => {
    await openCreateDialog();
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeInTheDocument();
  });
});

describe("schedule dialog - unsaved confirmation overlay (SCHED-D-050)", () => {
  it("renders confirm overlay when form is dirty and dialog is closed", async () => {
    const user = userEvent.setup();
    await openCreateDialog();
    await user.type(screen.getByLabelText("Prompt"), "Some text");
    click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
  });
});

describe("schedule dialog - agent selection (SCHED-D-051)", () => {
  it("sets selected agent when a different agent is chosen", async () => {
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
        id: "e0000000-0000-4000-a000-000000000002",
        displayName: "Research Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "v2",
        updatedAt: "2024-01-02T00:00:00Z",
      },
    ]);
    await openCreateDialog();
    const agentTrigger = screen.getByRole("combobox", { name: "Agent" });
    click(agentTrigger);
    const agentOption = await waitFor(() => {
      return getOpenListboxOption("Research Agent");
    });
    click(agentOption);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
        "Research Agent",
      );
    });
  });
});

describe("schedule dialog - frequency select (SCHED-D-054)", () => {
  it("shows date picker when frequency is changed to Once", async () => {
    await openCreateDialog();
    await switchFrequency("Once");
    await waitFor(() => {
      expect(screen.getByLabelText("Date")).toBeInTheDocument();
    });
  });
});

describe("schedule dialog - loop interval (SCHED-D-055)", () => {
  it("updates loop interval when a new value is selected", async () => {
    await openCreateDialog();
    await switchFrequency("Loop");
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Every" }),
      ).toBeInTheDocument();
    });
    const loopTrigger = screen.getByRole("combobox", { name: "Every" });
    click(loopTrigger);
    const loopOption = await waitFor(() => {
      return getOpenListboxOption("30 minutes");
    });
    click(loopOption);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Every" })).toHaveTextContent(
        "30 minutes",
      );
    });
  });
});

describe("schedule dialog - day of week (SCHED-D-057)", () => {
  it("toggles day selection when a day button is clicked", async () => {
    await openCreateDialog();
    await switchFrequency("Every week");
    await waitFor(() => {
      expect(screen.getByText("Tue")).toBeInTheDocument();
    });
    const tueBefore = screen.getByText("Tue");
    expect(tueBefore).toHaveAttribute("aria-pressed", "false");
    click(tueBefore);
    await waitFor(() => {
      expect(screen.getByText("Tue")).toHaveAttribute("aria-pressed", "true");
    });
  });
});

describe("schedule dialog - day of month (SCHED-D-058)", () => {
  it("updates day of month when selected", async () => {
    await openCreateDialog();
    await switchFrequency("Every month");
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Day of month" }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("combobox", { name: "Day of month" }));
    const domOption = await waitFor(() => {
      return getOpenListboxOption("15");
    });
    click(domOption);
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Day of month" }),
      ).toHaveTextContent("15");
    });
  });
});

describe("schedule dialog - hour select (SCHED-D-059)", () => {
  it("updates hour when a new hour is selected", async () => {
    await openCreateDialog();
    // Default freq is every_day which shows hour/minute selects
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Hour" }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("combobox", { name: "Hour" }));
    const hourOption = await waitFor(() => {
      return getOpenListboxOption("14");
    });
    click(hourOption);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Hour" })).toHaveTextContent(
        "14",
      );
    });
  });
});

describe("schedule dialog - minute select (SCHED-D-060)", () => {
  it("updates minute when a new minute is selected", async () => {
    await openCreateDialog();
    // Default freq is every_day which shows hour/minute selects
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Minute" }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("combobox", { name: "Minute" }));
    const minuteOption = await waitFor(() => {
      return getOpenListboxOption("30");
    });
    click(minuteOption);
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
    await openCreateDialog();
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
    await openCreateDialog();
    click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(
        screen.queryByText("Add schedule", { selector: "h2" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("schedule dialog - save button (SCHED-D-063)", () => {
  it("submits form and closes dialog when Create is clicked", async () => {
    let captured = false;
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
        captured = true;
        return respond(201, mockDeployResponse());
      }),
    );
    await openCreateDialog();
    const promptInput = screen.getByLabelText("Prompt");
    await fill(promptInput, "My task");
    click(screen.getByText("Create"));
    await waitFor(() => {
      expect(captured).toBeTruthy();
    });
    await waitFor(() => {
      expect(
        screen.queryByText("Add schedule", { selector: "h2" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("schedule dialog - close button (SCHED-D-064)", () => {
  it("closes dialog when Close button is clicked on clean form", async () => {
    await openCreateDialog();
    // The dialog has a custom Close button with aria-label="Close" (the X icon).
    // Use getAllByLabelText and pick the first one (the custom X button).
    click(screen.getAllByLabelText("Close")[0]);
    await waitFor(() => {
      expect(
        screen.queryByText("Add schedule", { selector: "h2" }),
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
    await openCreateDialog();
    await user.type(screen.getByLabelText("Prompt"), "Something");
    click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    click(screen.getByText("Discard Changes"));
    await waitFor(() => {
      expect(
        screen.queryByText("Add schedule", { selector: "h2" }),
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
    await openCreateDialog();
    await user.type(screen.getByLabelText("Prompt"), "Something");
    click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    click(screen.getByText("Continue Editing"));
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
    await openCreateDialog();
    await user.type(screen.getByLabelText("Prompt"), "Some text");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    // Dialog must remain open behind the confirm overlay.
    expect(
      screen.getByText("Add schedule", { selector: "h2" }),
    ).toBeInTheDocument();
  });

  it("closes dialog directly when ESC is pressed on a clean form", async () => {
    const user = userEvent.setup();
    await openCreateDialog();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByText("Add schedule", { selector: "h2" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
