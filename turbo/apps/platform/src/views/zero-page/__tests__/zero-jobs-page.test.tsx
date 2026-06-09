import { fireEvent, screen, waitFor } from "@testing-library/react";
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
import {
  type TeamComposeItem,
  zeroTeamContract,
} from "@vm0/api-contracts/contracts/zero-team";
import { createMockScheduleResponse } from "../../../mocks/handlers/api-schedules.ts";

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

    click(screen.getByText("Scheduled"));

    await waitFor(() => {
      expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();
      expect(screen.getAllByText("Office AC on")[0]).toBeInTheDocument();
    });
  });

  it("creates public and private agents, supports Enter submit, cancel, and card navigation", async () => {
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
    click(dialogCreateButton(dialog));

    await waitFor(() => {
      expect(screen.getByText("Marketing Bot")).toBeInTheDocument();
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

    click(screen.getByText("Marketing Bot"));

    await waitFor(() => {
      expect(document.title).toContain("Marketing Bot");
    });
  });
});
