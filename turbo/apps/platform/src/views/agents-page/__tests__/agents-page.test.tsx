import { screen, waitFor, within } from "@testing-library/react";
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

describe("agents page", () => {
  it("shows each agent creator from org members", async () => {
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
      within(agentCard("Research Agent")).getByText("Alice Admin"),
    ).toBeInTheDocument();
    expect(
      within(agentCard("Private Ops")).getByText("Bob Builder"),
    ).toBeInTheDocument();
  });
});
