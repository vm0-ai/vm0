import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockOrgMembers } from "../../../mocks/handlers/api-org-members.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function agentCard(name: string): HTMLElement {
  const nameElement = screen.getAllByText(name).find((element) => {
    return element.closest("main");
  });
  const card = nameElement?.closest("a");
  if (!card) {
    throw new Error(`Agent card not found: ${name}`);
  }
  return card;
}

const AGENTS = [
  {
    id: "c0000000-0000-4000-a000-000000000001",
    ownerId: "user_alice",
    displayName: "Research Agent",
    description: "Tracks market updates",
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "c0000000-0000-4000-a000-000000000002",
    ownerId: "user_bob",
    displayName: "Private Ops",
    description: "Handles internal tasks",
    sound: null,
    avatarUrl: null,
    visibility: "private",
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  },
] satisfies TeamComposeItem[];

async function expectVisibleTooltip(text: string): Promise<void> {
  const matches = await screen.findAllByText(text);
  const visibleMatch = matches.find((element) => {
    try {
      expect(element).toBeVisible();
      return true;
    } catch {
      return false;
    }
  });
  expect(visibleMatch).toBeDefined();
}

describe("agents page", () => {
  it("shows public agent creator on avatar hover", async () => {
    const user = userEvent.setup();
    setMockTeam(AGENTS);
    setMockOrgMembers({
      members: [
        {
          userId: "user_alice",
          email: "alice@example.com",
          firstName: "Alice",
          lastName: "Admin",
          imageUrl: "https://example.com/alice.png",
          role: "admin",
          joinedAt: "2024-01-01T00:00:00Z",
        },
        {
          userId: "user_bob",
          email: "bob@example.com",
          firstName: "Bob",
          lastName: "Builder",
          imageUrl: "",
          role: "member",
          joinedAt: "2024-01-01T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(agentCard("Research Agent")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Created by Alice Admin"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Created by Bob Builder"),
    ).not.toBeInTheDocument();

    const researchCreator = within(agentCard("Research Agent")).getByRole(
      "img",
      { name: "Created by Alice Admin" },
    );
    expect(
      within(agentCard("Private Ops")).queryByRole("img", {
        name: "Created by Bob Builder",
      }),
    ).not.toBeInTheDocument();

    await user.hover(researchCreator);
    await expectVisibleTooltip("Created by Alice Admin");
  });
});
