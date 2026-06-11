import { screen, waitFor, within } from "@testing-library/react";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  automationsV2ByRefContract,
  automationsV2MainContract,
} from "@vm0/api-contracts/contracts/automations-v2";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { toMockAutomationResponse } from "../../../mocks/handlers/api-automations-v2.ts";
import { createMockScheduleResponse } from "../../../mocks/handlers/api-schedules.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const zeroAgentId = "c0000000-0000-4000-a000-000000000001";
const researchAgentId = "a0000000-0000-4000-a000-000000000301";

function createAgent(id: string, displayName: string): TeamComposeItem {
  return {
    id,
    ownerId: "test-user-123",
    displayName,
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: [],
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2026-03-10T00:00:00Z",
  };
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function tabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

function selectOptionByLabel(
  label: string,
  option: string,
  container: HTMLElement,
): void {
  click(within(container).getByLabelText(label));
  click(screen.getByRole("option", { name: option }));
}

function mockSchedulePageStory(): void {
  context.mocks.data.team([
    createAgent(zeroAgentId, "Zero"),
    createAgent(researchAgentId, "Research Agent"),
  ]);
  context.mocks.data.schedules([
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000301",
      agentId: zeroAgentId,
      displayName: "Zero",
      name: "weekday-morning-brief",
      cronExpression: "30 14 * * 1-5",
      timezone: "UTC",
      prompt: "Send morning brief to the team channel",
      description: "Morning brief",
      enabled: true,
    }),
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000302",
      agentId: researchAgentId,
      displayName: "Research Agent",
      name: "office-climate-loop",
      triggerType: "loop",
      cronExpression: null,
      intervalSeconds: 2700,
      timezone: "UTC",
      prompt: "Turn on the air conditioning in my office",
      description: "Office AC",
      enabled: true,
    }),
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000303",
      agentId: zeroAgentId,
      displayName: "Zero",
      name: "monthly-billing-audit",
      cronExpression: "15 16 12 * *",
      timezone: "UTC",
      prompt: "Review monthly billing anomalies",
      description: "Billing audit",
      enabled: true,
    }),
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000304",
      agentId: researchAgentId,
      displayName: "Research Agent",
      name: "launch-readiness-check",
      triggerType: "once",
      cronExpression: null,
      atTime: "2026-06-12T18:45:00Z",
      timezone: "UTC",
      prompt: "Run the launch readiness checklist",
      description: "Release checklist",
      enabled: true,
    }),
  ]);
}

function mockScheduleCreateStory(): void {
  context.mocks.data.team([
    createAgent(zeroAgentId, "Zero"),
    createAgent(researchAgentId, "Research Agent"),
  ]);
  context.mocks.data.schedules([]);
}

function mockScheduleListEdgeStory(): void {
  context.mocks.data.team([createAgent(zeroAgentId, "Zero")]);
  context.mocks.data.schedules([
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000305",
      agentId: zeroAgentId,
      displayName: "Zero",
      name: "disabled-escalation-review",
      cronExpression: "7 9 * * 1-5",
      timezone: "UTC",
      prompt: "Review overnight escalations",
      description: null,
      enabled: false,
    }),
  ]);
}

async function openSchedulePage(): Promise<void> {
  detachedSetupPage({ context, path: "/schedules" });

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Automations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Week view")).toBeInTheDocument();
  });
}

async function openScheduleList(): Promise<void> {
  await openSchedulePage();
  click(tabByText("List"));

  await waitFor(() => {
    expect(screen.getByText("Instruction")).toBeInTheDocument();
    expect(screen.getByText("Schedule at")).toBeInTheDocument();
  });
}

async function openAutomationsList(): Promise<void> {
  detachedSetupPage({ context, path: "/schedules" });

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Automations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Week view")).toBeInTheDocument();
  });
  click(tabByText("List"));

  await waitFor(() => {
    expect(screen.getByText("Instruction")).toBeInTheDocument();
    expect(screen.getByText("Schedule at")).toBeInTheDocument();
  });
}

describe("zero schedule page", () => {
  it("shows scheduled work in the calendar", async () => {
    mockSchedulePageStory();

    await openSchedulePage();

    expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Every 45 minutes")[0]).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
    expect(screen.getByText("Once")).toBeInTheDocument();
    expect(
      screen.getByText("Every month on day 12 at 4:15 PM"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Once on 2026-06-12 at 6:45 PM"),
    ).toBeInTheDocument();
  });

  it("protects unsaved create edits", async () => {
    mockScheduleCreateStory();

    await openSchedulePage();

    click(buttonByText("Add automation"));

    const createDialog = await screen.findByRole("dialog");
    expect(within(createDialog).getByText("Add schedule")).toBeInTheDocument();
    expect(within(createDialog).getByText("Agent")).toBeInTheDocument();
    expect(within(createDialog).getByText("Prompt")).toBeInTheDocument();
    await fill(
      within(createDialog).getByLabelText("Prompt"),
      "Draft the weekly support handoff",
    );

    selectOptionByLabel("Agent", "Research Agent", createDialog);
    expect(
      within(createDialog).getByText("Research Agent"),
    ).toBeInTheDocument();

    selectOptionByLabel("Time", "Loop", createDialog);
    expect(within(createDialog).getByText("Every")).toBeInTheDocument();
    expect(within(createDialog).getByText("15 minutes")).toBeInTheDocument();

    selectOptionByLabel("Every", "60 minutes", createDialog);
    expect(within(createDialog).getByText("60 minutes")).toBeInTheDocument();

    selectOptionByLabel("Time", "Every week", createDialog);
    expect(within(createDialog).getByText("Day of week")).toBeInTheDocument();
    expect(buttonByText("Mon", createDialog)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    click(buttonByText("Wed", createDialog));
    expect(buttonByText("Wed", createDialog)).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    selectOptionByLabel("Time", "Every month", createDialog);
    expect(within(createDialog).getByText("Day of month")).toBeInTheDocument();
    selectOptionByLabel("Day of month", "12", createDialog);
    expect(within(createDialog).getByText("12")).toBeInTheDocument();

    selectOptionByLabel("Time", "Once", createDialog);
    expect(within(createDialog).getByLabelText("Date")).toBeInTheDocument();

    expect(
      within(createDialog).getByDisplayValue(
        "Draft the weekly support handoff",
      ),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", createDialog));

    const confirmClose = await screen.findByRole("alertdialog");
    expect(
      within(confirmClose).getByText("You have unsaved changes"),
    ).toBeInTheDocument();
    click(buttonByText("Continue Editing", confirmClose));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(
      within(createDialog).getByDisplayValue(
        "Draft the weekly support handoff",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Cancel", createDialog));
    const discardChanges = await screen.findByRole("alertdialog");
    click(buttonByText("Discard Changes", discardChanges));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("creates a schedule and opens the new detail page", async () => {
    mockScheduleCreateStory();

    await openSchedulePage();

    click(buttonByText("Add automation"));

    const createDialog = await screen.findByRole("dialog");
    await fill(
      within(createDialog).getByLabelText("Prompt"),
      "Draft the weekly support handoff",
    );
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: "Draft the weekly support handoff",
        }),
      ).toBeInTheDocument();
    });
  });

  it("shows scheduled work in the list", async () => {
    mockSchedulePageStory();

    await openScheduleList();

    expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Office AC")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Every 45 minutes")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Billing audit")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Release checklist")[0]).toBeInTheDocument();
    expect(
      screen.getAllByText("Every month on day 12 at 4:15 PM")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Once on 2026-06-12 at 6:45 PM")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByLabelText(
        "Open schedule Send morning brief to the team channel",
      )[0],
    ).toBeInTheDocument();
  });

  it("opens create scheduling from the empty list", async () => {
    mockScheduleCreateStory();

    await openSchedulePage();
    click(tabByText("List"));

    await waitFor(() => {
      expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Set up a schedule and your agents will handle the rest.",
        ),
      ).toBeInTheDocument();
    });

    const addScheduleButtons = queryAllByRoleFast("button").filter(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() ===
          "Add automation"
        );
      },
    );
    click(addScheduleButtons[addScheduleButtons.length - 1]!);

    const createDialog = await screen.findByRole("dialog");
    expect(within(createDialog).getByText("Agent")).toBeInTheDocument();
    expect(within(createDialog).getByText("Prompt")).toBeInTheDocument();
  });

  it("keeps the list loading state visible until schedules resolve", async () => {
    context.mocks.data.team([
      createAgent(zeroAgentId, "Zero"),
      createAgent(researchAgentId, "Research Agent"),
    ]);

    const schedulesReady = context.mocks.deferred<void>();

    context.mocks.api(automationsV2MainContract.list, async ({ respond }) => {
      await schedulesReady.promise;
      return respond(200, {
        automations: [
          toMockAutomationResponse(
            createMockScheduleResponse({
              id: "f0000001-0000-4000-a000-000000000306",
              agentId: researchAgentId,
              displayName: "Research Agent",
              name: "launch-loading-check",
              cronExpression: "45 17 * * 1-5",
              timezone: "UTC",
              prompt: "Check launch risks before standup",
              description: "Launch loading check",
              enabled: true,
            }),
          ),
        ],
      });
    });

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Automations" }),
      ).toBeInTheDocument();
    });
    click(tabByText("List"));

    await waitFor(() => {
      expect(screen.getByTestId("schedule-list-skeleton")).toBeInTheDocument();
    });

    schedulesReady.resolve();

    await waitFor(() => {
      expect(
        screen.queryByTestId("schedule-list-skeleton"),
      ).not.toBeInTheDocument();
      expect(
        screen.getAllByText("Launch loading check").length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText("Every weekday at 5:45 PM").length,
      ).toBeGreaterThan(0);
    });
  });

  it("opens disabled prompt-only schedules from list rows", async () => {
    mockScheduleListEdgeStory();

    await openScheduleList();

    expect(
      screen.getAllByText("Review overnight escalations")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Every weekday at 9:07 AM")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Enable Every weekday at 9:07 AM")[0],
    ).toBeInTheDocument();

    click(
      screen.getAllByLabelText("Open schedule Review overnight escalations")[0],
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Review overnight escalations" }),
      ).toBeInTheDocument();
    });
  });

  it("toggles and runs schedules from the list", async () => {
    mockSchedulePageStory();

    await openScheduleList();

    click(screen.getAllByLabelText("Disable Every weekday at 2:30 PM")[0]);

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Enable Every weekday at 2:30 PM")[0],
      ).toBeInTheDocument();
    });

    click(screen.getAllByLabelText("More actions for Every 45 minutes")[0]);
    click(menuItemByText("Run now"));

    await waitFor(() => {
      expect(screen.getByText(/Run started/u)).toBeInTheDocument();
      expect(screen.getByText("View activity")).toBeInTheDocument();
      expect(screen.getAllByText("Office AC")[0]).toBeInTheDocument();
    });
  });

  it("manages automations through the schedule page surface", async () => {
    mockNow();
    mockSchedulePageStory();

    await openAutomationsList();

    expect(
      screen.getByRole("heading", { name: "Automations" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();

    click(screen.getAllByLabelText("Disable Every weekday at 2:30 PM")[0]);

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Enable Every weekday at 2:30 PM")[0],
      ).toBeInTheDocument();
    });

    click(screen.getAllByLabelText("Enable Every weekday at 2:30 PM")[0]);

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Disable Every weekday at 2:30 PM")[0],
      ).toBeInTheDocument();
    });

    click(screen.getAllByLabelText("More actions for Every 45 minutes")[0]);
    click(menuItemByText("Run now"));

    await waitFor(() => {
      expect(screen.getByText(/Run started/u)).toBeInTheDocument();
      expect(screen.getByText("View activity")).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText("More actions for Every weekday at 2:30 PM")[0],
    );
    click(menuItemByText("Delete"));

    const deleteDialog = await screen.findByRole("dialog");
    click(buttonByText("Delete", deleteDialog));

    await waitFor(() => {
      expect(screen.queryByText("Morning brief")).not.toBeInTheDocument();
    });

    click(buttonByText("Add automation"));

    const createDialog = await screen.findByRole("dialog");
    await fill(
      within(createDialog).getByLabelText("Prompt"),
      "Review automation coverage",
    );
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Review automation coverage" }),
      ).toBeInTheDocument();
    });
  });

  it("surfaces run-now failures from the schedule list", async () => {
    mockSchedulePageStory();
    context.mocks.api(automationsV2ByRefContract.run, ({ respond }) => {
      return respond(503, {
        error: {
          message: "Runner queue unavailable",
          code: "PROVIDER_UNAVAILABLE",
        },
      });
    });

    await openScheduleList();

    click(screen.getAllByLabelText("More actions for Every 45 minutes")[0]);
    click(menuItemByText("Run now"));

    await waitFor(() => {
      expect(screen.getByText("Runner queue unavailable")).toBeInTheDocument();
      expect(screen.getAllByText("Office AC")[0]).toBeInTheDocument();
    });
  });

  it("deletes a schedule from the list after confirmation", async () => {
    mockSchedulePageStory();

    await openScheduleList();

    click(
      screen.getAllByLabelText("More actions for Every weekday at 2:30 PM")[0],
    );
    click(menuItemByText("Delete"));

    const deleteDialog = await screen.findByRole("dialog");
    expect(
      within(deleteDialog).getByText("Delete schedule?"),
    ).toBeInTheDocument();
    expect(
      within(deleteDialog).getByText("weekday-morning-brief"),
    ).toBeInTheDocument();

    click(buttonByText("Cancel", deleteDialog));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText("More actions for Every weekday at 2:30 PM")[0],
    );
    click(menuItemByText("Delete"));

    const confirmDeleteDialog = await screen.findByRole("dialog");
    click(buttonByText("Delete", confirmDeleteDialog));

    await waitFor(() => {
      expect(screen.queryByText("Morning brief")).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("Office AC")[0]).toBeInTheDocument();
  });

  it("opens a schedule detail from the list", async () => {
    mockSchedulePageStory();

    await openScheduleList();

    click(screen.getAllByLabelText("More actions for Every 45 minutes")[0]);
    click(menuItemByText("Edit"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Office AC" }),
      ).toBeInTheDocument();
    });
  });
});
