import { screen, waitFor, within } from "@testing-library/react";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
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
  ]);
}

describe("zero schedule page", () => {
  it("shows scheduled work across calendar, list, create dialog, and row actions", async () => {
    mockSchedulePageStory();

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
      expect(screen.getByText("Week view")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Every 45 minutes")[0]).toBeInTheDocument();

    click(buttonByText("Add schedule"));

    const createDialog = await screen.findByRole("dialog");
    expect(within(createDialog).getByText("Add schedule")).toBeInTheDocument();
    expect(within(createDialog).getByText("Agent")).toBeInTheDocument();
    expect(within(createDialog).getByText("Prompt")).toBeInTheDocument();
    await fill(
      within(createDialog).getByLabelText("Prompt"),
      "Draft the weekly support handoff",
    );
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

    click(tabByText("List"));

    await waitFor(() => {
      expect(screen.getByText("Instruction")).toBeInTheDocument();
      expect(screen.getByText("Schedule at")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Office AC")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Every 45 minutes")[0]).toBeInTheDocument();
    expect(
      screen.getAllByLabelText(
        "Open schedule Send morning brief to the team channel",
      )[0],
    ).toBeInTheDocument();

    click(screen.getAllByLabelText("Disable Every weekday at 2:30 PM")[0]);

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Enable Every weekday at 2:30 PM")[0],
      ).toBeInTheDocument();
    });

    click(screen.getAllByLabelText("More actions for Every 45 minutes")[0]);
    click(menuItemByText("Run now"));

    await waitFor(() => {
      expect(screen.getAllByText("Office AC")[0]).toBeInTheDocument();
    });

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

    click(screen.getAllByLabelText("More actions for Every 45 minutes")[0]);
    click(menuItemByText("Edit"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Office AC" }),
      ).toBeInTheDocument();
    });
  });
});
