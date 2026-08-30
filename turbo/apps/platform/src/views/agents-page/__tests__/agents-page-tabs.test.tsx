import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMockAgentResponse } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

const agents = [
  createMockAgentResponse({
    agentId: "c0000000-0000-4000-a000-000000000001",
    ownerId: "user_alice",
    displayName: "Research Agent",
    description: "Tracks market updates",
    sound: null,
    avatarUrl: null,
    visibility: "public",
  }),
  createMockAgentResponse({
    agentId: "c0000000-0000-4000-a000-000000000002",
    ownerId: "user_bob",
    displayName: "Private Ops",
    description: "Handles internal tasks",
    sound: null,
    avatarUrl: null,
    visibility: "private",
  }),
] satisfies AgentResponse[];

function findAgentCard(name: string): HTMLElement | null {
  const nameElement = screen.queryAllByText(name).find((element) => {
    return element.closest("main");
  });
  return nameElement?.closest("a") ?? null;
}

function agentCard(name: string): HTMLElement {
  const card = findAgentCard(name);
  if (!card) {
    throw new Error(`Agent card not found: ${name}`);
  }
  return card;
}

function visibilitySegment(label: "Public" | "Private"): HTMLElement {
  const found = queryAllByRoleFast("radio").find((element) => {
    return element.textContent === label;
  });
  if (!found) {
    throw new Error(`Segment not found: ${label}`);
  }
  return found;
}

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

describe("agents page (redesign)", () => {
  it("filters agents by tab and shows creator only on public cards", async () => {
    const user = userEvent.setup();
    context.mocks.data.agents(agents);
    context.mocks.data.orgMembers({
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

    detachedSetupPage({
      context,
      path: "/agents",
    });

    await waitFor(() => {
      expect(visibilitySegment("Private")).toBeInTheDocument();
    });

    // Private tab: only private agents, no creator tooltip.
    await user.click(visibilitySegment("Private"));
    await waitFor(() => {
      expect(agentCard("Private Ops")).toBeInTheDocument();
    });
    expect(findAgentCard("Research Agent")).toBeNull();
    expect(
      within(agentCard("Private Ops")).queryByText("Created by Bob Builder"),
    ).not.toBeInTheDocument();

    // Public tab: only public agents, each surfacing the creator on hover.
    await user.click(visibilitySegment("Public"));
    await waitFor(() => {
      expect(agentCard("Research Agent")).toBeInTheDocument();
    });
    expect(findAgentCard("Private Ops")).toBeNull();
    expect(
      screen.queryByText("Created by Alice Admin"),
    ).not.toBeInTheDocument();

    await user.hover(
      within(agentCard("Research Agent")).getByText("Research Agent"),
    );
    await expectVisibleTooltip("Created by Alice Admin");
  });

  it("shows the private empty state when there are no private agents", async () => {
    const user = userEvent.setup();
    context.mocks.data.agents([agents[0]]);
    context.mocks.data.orgMembers({ members: [] });

    detachedSetupPage({
      context,
      path: "/agents",
    });

    await waitFor(() => {
      expect(visibilitySegment("Private")).toBeInTheDocument();
    });
    await user.click(visibilitySegment("Private"));
    await waitFor(() => {
      expect(screen.getByText("No private agents yet")).toBeInTheDocument();
    });
  });

  it("shows agent unread indicators", async () => {
    const user = userEvent.setup();
    context.mocks.data.agents(agents);
    context.mocks.data.orgMembers({ members: [] });

    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: {
          [agents[0].agentId]: "unread",
          [agents[1].agentId]: "unread",
        },
        threads: {},
      });
    });

    detachedSetupPage({
      context,
      path: "/agents",
    });

    await waitFor(() => {
      expect(visibilitySegment("Private")).toBeInTheDocument();
    });

    await user.click(visibilitySegment("Private"));
    await waitFor(() => {
      expect(agentCard("Private Ops")).toBeInTheDocument();
    });
    expect(
      within(agentCard("Private Ops")).getByLabelText("Unread"),
    ).toHaveClass("border-card");

    await user.click(visibilitySegment("Public"));
    await waitFor(() => {
      expect(agentCard("Research Agent")).toBeInTheDocument();
    });
    expect(
      within(agentCard("Research Agent")).getByLabelText("Unread"),
    ).toHaveClass("border-card");
  });
});
