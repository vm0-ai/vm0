import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  zeroAgentInstructionsContract,
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { automationsV2ByRefContract } from "@vm0/api-contracts/contracts/automations-v2";
import type { ScheduleResponse } from "@vm0/api-contracts/contracts/zero-schedules";
import {
  type TeamComposeItem,
  zeroTeamContract,
} from "@vm0/api-contracts/contracts/zero-team";
import { toMockAutomationResponse } from "../../../mocks/handlers/api-automations-v2.ts";
import { createMockScheduleResponse } from "../../../mocks/handlers/schedules-store.ts";

const context = testContext();

function createDefaultAgent(): TeamComposeItem {
  return {
    id: "c0000000-0000-4000-a000-000000000001",
    ownerId: "test-user-123",
    displayName: "Zero",
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: [],
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function mockAgentsPage(team: TeamComposeItem[]): void {
  context.mocks.data.team(team);
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const agent = team.find((item) => {
      return item.id === params.id;
    });
    if (!agent) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      agentId: agent.id,
      ownerId: agent.ownerId ?? "test-user-123",
      description: agent.description,
      displayName: agent.displayName,
      sound: agent.sound,
      avatarUrl: agent.avatarUrl,
      customSkills: agent.customSkills ?? [],
      visibility: agent.visibility,
    });
  });
}

function findSectionCreateButton(sectionName: "Public" | "Private"): Element {
  const section = screen.getByText(sectionName).closest("section");
  if (!section) {
    throw new Error(`${sectionName} section not found`);
  }
  const createButton = queryAllByRoleFast("button", section).find((button) => {
    return button.textContent?.trim() === "Create";
  });
  if (!createButton) {
    throw new Error(`${sectionName} create button not found`);
  }
  return createButton;
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
  option: string | RegExp,
  container: HTMLElement,
): void {
  click(within(container).getByLabelText(label));
  click(screen.getByRole("option", { name: option }));
}

async function openCreateDialog(
  sectionName: "Public" | "Private",
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getByText(sectionName)).toBeInTheDocument();
  });
  click(findSectionCreateButton(sectionName));
  return await screen.findByRole("dialog");
}

function dialogCreateButton(dialog: HTMLElement): HTMLElement {
  const createButton = queryAllByRoleFast("button", dialog).find((button) => {
    return button.textContent?.trim() === "Create";
  });
  if (!createButton) {
    throw new Error("dialog create button not found");
  }
  return createButton;
}

describe("zero jobs page", () => {
  it("shows agents, create actions, and scheduled work across the management surfaces", async () => {
    mockAgentsPage([
      createDefaultAgent(),
      {
        id: "a0000000-0000-4000-a000-000000000101",
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: "Finds and summarizes information",
        sound: null,
        avatarUrl: null,
        customSkills: [],
        visibility: "public",
        headVersionId: "version_2",
        updatedAt: "2024-01-02T00:00:00Z",
      },
      {
        id: "a0000000-0000-4000-a000-000000000102",
        ownerId: "test-user-123",
        displayName: null,
        description: "Writes content based on research",
        sound: null,
        avatarUrl: null,
        customSkills: [],
        visibility: "private",
        headVersionId: "version_3",
        updatedAt: "2024-01-03T00:00:00Z",
      },
    ]);
    context.mocks.data.schedules([
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000101",
        description: "Morning brief",
        prompt: "Send morning brief to the team channel",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000102",
        description: "Office AC on",
        prompt: "Turn on the air conditioning in my office",
      }),
    ]);

    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
      expect(
        screen.getByText("Finds and summarizes information"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("a0000000-0000-4000-a000-000000000102"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Writes content based on research"),
      ).toBeInTheDocument();
    });
    expect(findSectionCreateButton("Public")).toBeInTheDocument();
    expect(findSectionCreateButton("Private")).toBeInTheDocument();

    click(screen.getByText("Automations"));

    await waitFor(() => {
      expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();
      expect(screen.getAllByText("Office AC on")[0]).toBeInTheDocument();
    });
  });

  it("creates public and private agents, customizes avatars, supports Enter submit, cancel, and card navigation", async () => {
    let team: TeamComposeItem[] = [createDefaultAgent()];
    mockAgentsPage(team);
    context.mocks.api(zeroTeamContract.list, ({ respond }) => {
      return respond(200, team);
    });
    context.mocks.api(zeroAgentsMainContract.create, ({ body, respond }) => {
      const agent: TeamComposeItem = {
        id:
          body.visibility === "private"
            ? "a0000000-0000-4000-a000-000000000202"
            : "a0000000-0000-4000-a000-000000000201",
        ownerId: "test-user-123",
        displayName: body.displayName ?? null,
        description: null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        customSkills: [],
        visibility: body.visibility ?? "public",
        headVersionId: "version_created",
        updatedAt: "2026-03-10T00:00:00Z",
      };
      team = [...team, agent];
      return respond(201, {
        agentId: agent.id,
        ownerId: "test-user-123",
        description: null,
        displayName: agent.displayName,
        sound: agent.sound,
        avatarUrl: agent.avatarUrl,
        customSkills: [],
        visibility: agent.visibility,
      });
    });
    context.mocks.api(
      zeroAgentInstructionsContract.update,
      ({ params, respond }) => {
        const agent = team.find((item) => {
          return item.id === params.id;
        });
        return respond(200, {
          agentId: params.id,
          ownerId: "test-user-123",
          description: null,
          displayName: agent?.displayName ?? null,
          sound: agent?.sound ?? null,
          avatarUrl: agent?.avatarUrl ?? null,
          customSkills: [],
          visibility: agent?.visibility ?? "public",
        });
      },
    );

    detachedSetupPage({ context, path: "/agents" });

    let dialog = await openCreateDialog("Public");
    await fill(
      screen.getByPlaceholderText("e.g. Research Assistant"),
      "Marketing Bot",
    );
    click(screen.getByLabelText("Customize avatar"));
    const avatarDialog = await screen.findByRole("dialog", {
      name: "Give your agent a face",
    });
    expect(screen.getByText("Angle")).toBeInTheDocument();
    click(screen.getByLabelText("Randomize avatar"));
    click(screen.getByLabelText("Next step"));
    await waitFor(() => {
      expect(screen.getByText("Skin")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    await waitFor(() => {
      expect(screen.getByText("Mood")).toBeInTheDocument();
      expect(screen.getByText("Chill")).toBeInTheDocument();
      expect(screen.getByText("Normal")).toBeInTheDocument();
      expect(screen.getByText("Hyped")).toBeInTheDocument();
    });
    click(screen.getByText("Chill"));
    click(screen.getByText("Use this avatar"));
    await waitFor(() => {
      expect(avatarDialog).not.toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "New agent" }),
      ).toBeInTheDocument();
    });
    click(dialogCreateButton(dialog));

    await waitFor(() => {
      expect(screen.getByText("Marketing Bot")).toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "Marketing Bot" }),
      ).toBeInTheDocument();
    });

    dialog = await openCreateDialog("Private");
    expect(screen.getByText("Create a new private agent")).toBeInTheDocument();
    click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    dialog = await openCreateDialog("Private");
    await fill(
      screen.getByPlaceholderText("e.g. Research Assistant"),
      "Private Analyst",
    );
    fireEvent.keyDown(screen.getByPlaceholderText("e.g. Research Assistant"), {
      key: "Enter",
    });

    await waitFor(() => {
      expect(screen.getByText("Private Analyst")).toBeInTheDocument();
      expect(screen.getByLabelText("Private agent")).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(dialog).not.toBeInTheDocument();

    const marketingBotLink = queryAllByRoleFast("link").find((link) => {
      return (
        link.getAttribute("href") ===
        "/agents/a0000000-0000-4000-a000-000000000201"
      );
    });
    if (!marketingBotLink) {
      throw new Error("Marketing Bot detail link not found");
    }
    click(marketingBotLink);

    await waitFor(() => {
      expect(document.title).toContain("Marketing Bot");
    });
  });

  it("edits an agent weekly schedule while preserving custom minute and timezone fields", async () => {
    const agentId = "a0000000-0000-4000-a000-000000000331";
    mockAgentsPage([
      createDefaultAgent(),
      {
        id: agentId,
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: "Finds launch risks",
        sound: null,
        avatarUrl: null,
        customSkills: [],
        visibility: "public",
        headVersionId: "version_5",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    let schedules: ScheduleResponse[] = [
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000331",
        agentId,
        name: "monday-risk-review",
        cronExpression: "17 9 * * 1",
        timezone: "UTC",
        description: "Monday risks",
        prompt: "Summarize launch risks",
      }),
    ];
    let capturedUpdateBody: unknown = null;
    let capturedTriggerBody: unknown = null;
    context.mocks.data.schedules(schedules);
    context.mocks.api(
      automationsV2ByRefContract.update,
      ({ body, respond }) => {
        capturedUpdateBody = body;
        const currentSchedule = schedules[0];
        if (!currentSchedule) {
          throw new Error("schedule fixture not found");
        }
        const updated = createMockScheduleResponse({
          ...currentSchedule,
          prompt: body.instruction ?? currentSchedule.prompt,
          description:
            body.description === undefined
              ? currentSchedule.description
              : body.description,
          updatedAt: "2026-03-10T00:05:00Z",
        });
        schedules = [updated];
        context.mocks.data.schedules(schedules);
        return respond(200, toMockAutomationResponse(updated));
      },
    );
    context.mocks.api(
      automationsV2ByRefContract.addTrigger,
      ({ body, respond }) => {
        capturedTriggerBody = body;
        const currentSchedule = schedules[0];
        if (!currentSchedule) {
          throw new Error("schedule fixture not found");
        }
        if (body.kind !== "cron") {
          throw new Error("expected a cron trigger replacement");
        }
        const updated = createMockScheduleResponse({
          ...currentSchedule,
          triggerType: "cron",
          cronExpression: body.cronExpression,
          atTime: null,
          intervalSeconds: null,
          timezone: body.timezone ?? "UTC",
          updatedAt: "2026-03-10T00:05:00Z",
        });
        schedules = [updated];
        context.mocks.data.schedules(schedules);
        const trigger = toMockAutomationResponse(updated).triggers[0];
        if (!trigger) {
          throw new Error("expected a projected trigger");
        }
        return respond(201, { trigger });
      },
    );

    detachedSetupPage({ context, path: `/agents/${agentId}?tab=schedule` });

    await waitFor(() => {
      expect(
        screen.getByText("Research Agent's scheduled tasks"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText("Every week on Monday at 9:17 AM")[0],
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText(
        "More actions for Every week on Monday at 9:17 AM",
      )[0],
    );
    click(menuItemByText("Edit"));
    const editScheduleDialog = await screen.findByRole("dialog", {
      name: "Edit schedule",
    });

    expect(
      within(editScheduleDialog).getByText("Day of week"),
    ).toBeInTheDocument();
    expect(buttonByText("Mon", editScheduleDialog)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    click(buttonByText("Wed", editScheduleDialog));
    click(buttonByText("Mon", editScheduleDialog));
    expect(buttonByText("Wed", editScheduleDialog)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(buttonByText("Mon", editScheduleDialog)).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    selectOptionByLabel("Hour", "16", editScheduleDialog);
    selectOptionByLabel("Minute", "45", editScheduleDialog);
    selectOptionByLabel(
      "Timezone",
      /^\(GMT[+-]\d{2}:\d{2}\) India Standard Time \(IST\)$/u,
      editScheduleDialog,
    );
    await fill(
      within(editScheduleDialog).getByLabelText(/Description/u),
      "Updated Wednesday risks",
    );
    click(buttonByText("Save", editScheduleDialog));

    await waitFor(() => {
      expect(
        screen.getAllByText("Every week on Wednesday at 10:15 PM")[0],
      ).toBeInTheDocument();
      expect(capturedUpdateBody).toMatchObject({
        instruction: "Summarize launch risks",
      });
      expect(capturedTriggerBody).toMatchObject({
        kind: "cron",
        cronExpression: "45 16 * * 3",
        timezone: "Asia/Kolkata",
      });
    });
  });

  it("switches through agent detail tabs from a loaded agent page", async () => {
    const agentId = "a0000000-0000-4000-a000-000000000301";
    mockAgentsPage([
      createDefaultAgent(),
      {
        id: agentId,
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: "Finds launch risks",
        sound: "professional",
        avatarUrl: null,
        customSkills: [],
        visibility: "public",
        headVersionId: "version_4",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.data.schedules([
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000301",
        agentId,
        name: "weekday-risk-digest",
        cronExpression: "30 14 * * 1-5",
        description: "Research digest",
        prompt: "Summarize launch risks",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000302",
        agentId,
        name: "office-climate-loop",
        triggerType: "loop",
        cronExpression: null,
        intervalSeconds: 2700,
        description: "Office AC",
        prompt: "Turn on the office air conditioning",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000303",
        agentId,
        name: "wednesday-risk-review",
        cronExpression: "15 14 * * 3",
        description: "Wednesday risks",
        prompt: "Review launch risks every Wednesday",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000304",
        agentId,
        name: "monthly-risk-audit",
        cronExpression: "5 12 12 * *",
        description: "Billing audit",
        prompt: "Review monthly billing anomalies",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000305",
        agentId,
        name: "launch-readiness-check",
        triggerType: "once",
        cronExpression: null,
        atTime: "2026-06-12T18:45:00Z",
        description: "Release checklist",
        prompt: "Run the launch readiness checklist",
      }),
    ]);
    context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, {
        content: "Summarize risks with concise bullets.",
        filename: "AGENTS.md",
      });
    });

    detachedSetupPage({ context, path: `/agents/${agentId}` });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Chat with Research Agent"),
      ).toBeInTheDocument();
      expect(screen.getByText("Finds launch risks")).toBeInTheDocument();
    });

    expect(tabByText("Authorization")).toHaveAttribute("aria-selected", "true");

    click(tabByText("Scheduled"));
    await waitFor(() => {
      expect(screen.getAllByText("Research digest").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Office AC").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Wednesday risks").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Billing audit").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Release checklist").length).toBeGreaterThan(
        0,
      );
      expect(screen.getByText("Add schedule")).toBeInTheDocument();
    });
    expect(
      screen.getAllByText("Every weekday at 2:30 PM")[0],
    ).toBeInTheDocument();
    expect(screen.getAllByText("Every 45 minutes")[0]).toBeInTheDocument();
    expect(
      screen.getAllByText("Every week on Wednesday at 2:15 PM")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Every month on day 12 at 12:05 PM")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Once on 2026-06-12 at 6:45 PM")[0],
    ).toBeInTheDocument();

    click(tabByText("Calendar"));
    await waitFor(() => {
      expect(screen.getAllByText("Research digest")[0]).toBeInTheDocument();
    });

    click(tabByText("List"));
    await waitFor(() => {
      expect(screen.getByText("Instruction")).toBeInTheDocument();
    });

    click(screen.getByText("Add schedule"));
    const createScheduleDialog = await screen.findByRole("dialog", {
      name: "Add schedule",
    });
    await fill(screen.getByLabelText("Prompt"), "Prepare launch summary");
    click(buttonByText("Create", createScheduleDialog));

    await waitFor(() => {
      expect(screen.getByText("Prepare launch summary")).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText(
        "More actions for Every week on Wednesday at 2:15 PM",
      )[0],
    );
    click(menuItemByText("Edit"));
    const editScheduleDialog = await screen.findByRole("dialog", {
      name: "Edit schedule",
    });
    expect(
      within(editScheduleDialog).getByText("Day of week"),
    ).toBeInTheDocument();
    await fill(
      screen.getByLabelText(/Description/u),
      "Updated Wednesday risks",
    );
    click(buttonByText("Save", editScheduleDialog));

    await waitFor(() => {
      expect(
        screen.getAllByText("Updated Wednesday risks")[0],
      ).toBeInTheDocument();
    });

    click(screen.getAllByLabelText("More actions for Every 45 minutes")[0]);
    click(menuItemByText("Run now"));

    await waitFor(() => {
      expect(screen.getByText(/Run started/u)).toBeInTheDocument();
      expect(screen.getByText("View activity")).toBeInTheDocument();
    });

    click(screen.getAllByLabelText("Disable Every weekday at 2:30 PM")[0]);

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Enable Every weekday at 2:30 PM")[0],
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText(
        "More actions for Every month on day 12 at 12:05 PM",
      )[0],
    );
    click(menuItemByText("Delete"));
    const deleteScheduleDialog = await screen.findByRole("dialog");
    expect(
      within(deleteScheduleDialog).getByText("Delete schedule?"),
    ).toBeInTheDocument();
    expect(
      within(deleteScheduleDialog).getByText("monthly-risk-audit"),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", deleteScheduleDialog));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText(
        "More actions for Every month on day 12 at 12:05 PM",
      )[0],
    );
    click(menuItemByText("Delete"));
    const confirmDeleteDialog = await screen.findByRole("dialog");
    click(buttonByText("Delete", confirmDeleteDialog));

    await waitFor(() => {
      expect(screen.queryByText("Billing audit")).not.toBeInTheDocument();
    });

    click(tabByText("Profile"));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
      expect(
        screen.getByDisplayValue("Finds launch risks"),
      ).toBeInTheDocument();
    });

    click(tabByText("Instructions"));
    await waitFor(() => {
      expect(
        screen.getByText("Summarize risks with concise bullets."),
      ).toBeInTheDocument();
    });
  });
});
