import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const agents = [
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

function tab(label: "Public" | "Private"): HTMLElement {
  const found = queryAllByRoleFast("tab").find((element) => {
    return element.textContent === label;
  });
  if (!found) {
    throw new Error(`Tab not found: ${label}`);
  }
  return found;
}

describe("agents page (redesign)", () => {
  it("filters agents by tab and shows the creator on every card", async () => {
    const user = userEvent.setup();
    context.mocks.data.team(agents);
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
      featureSwitches: { [FeatureSwitchKey.AgentsPageRedesign]: true },
    });

    await waitFor(() => {
      expect(tab("Private")).toBeInTheDocument();
    });

    // Private tab: only private agents, each with a creator footer.
    await user.click(tab("Private"));
    await waitFor(() => {
      expect(agentCard("Private Ops")).toBeInTheDocument();
    });
    expect(screen.queryByText("Research Agent")).not.toBeInTheDocument();
    expect(
      within(agentCard("Private Ops")).getByText("Created by Bob Builder"),
    ).toBeInTheDocument();

    // Public tab: only public agents, each with a creator footer.
    await user.click(tab("Public"));
    await waitFor(() => {
      expect(agentCard("Research Agent")).toBeInTheDocument();
    });
    expect(screen.queryByText("Private Ops")).not.toBeInTheDocument();
    expect(
      within(agentCard("Research Agent")).getByText("Created by Alice Admin"),
    ).toBeInTheDocument();
  });

  it("shows the private empty state when there are no private agents", async () => {
    const user = userEvent.setup();
    context.mocks.data.team([agents[0]]);
    context.mocks.data.orgMembers({ members: [] });

    detachedSetupPage({
      context,
      path: "/agents",
      featureSwitches: { [FeatureSwitchKey.AgentsPageRedesign]: true },
    });

    await waitFor(() => {
      expect(tab("Private")).toBeInTheDocument();
    });
    await user.click(tab("Private"));
    await waitFor(() => {
      expect(screen.getByText("No private agents yet")).toBeInTheDocument();
    });
  });

  it("shows agent unread indicators behind the feature switch", async () => {
    const user = userEvent.setup();
    context.mocks.data.team(agents);
    context.mocks.data.orgMembers({ members: [] });

    context.mocks.api(chatThreadsContract.unreadAgents, ({ respond }) => {
      return respond(200, {
        agentIds: [agents[0].id, agents[1].id],
      });
    });

    detachedSetupPage({
      context,
      path: "/agents",
      featureSwitches: {
        [FeatureSwitchKey.AgentsPageRedesign]: true,
        [FeatureSwitchKey.AgentUnreadIndicators]: true,
      },
    });

    await waitFor(() => {
      expect(tab("Private")).toBeInTheDocument();
    });

    await user.click(tab("Private"));
    await waitFor(() => {
      expect(agentCard("Private Ops")).toBeInTheDocument();
    });
    expect(
      within(agentCard("Private Ops")).getByLabelText("Unread"),
    ).toHaveClass("border-card");

    await user.click(tab("Public"));
    await waitFor(() => {
      expect(agentCard("Research Agent")).toBeInTheDocument();
    });
    expect(
      within(agentCard("Research Agent")).getByLabelText("Unread"),
    ).toHaveClass("border-card");
  });

  it("hides agent unread indicators when the feature switch is off", async () => {
    const user = userEvent.setup();
    context.mocks.data.team(agents);
    context.mocks.data.orgMembers({ members: [] });

    context.mocks.api(chatThreadsContract.unreadAgents, ({ respond }) => {
      return respond(200, {
        agentIds: [agents[0].id, agents[1].id],
      });
    });

    detachedSetupPage({
      context,
      path: "/agents",
      featureSwitches: {
        [FeatureSwitchKey.AgentsPageRedesign]: true,
        [FeatureSwitchKey.AgentUnreadIndicators]: false,
      },
    });

    await waitFor(() => {
      expect(tab("Private")).toBeInTheDocument();
    });

    await user.click(tab("Private"));
    await waitFor(() => {
      expect(agentCard("Private Ops")).toBeInTheDocument();
    });
    expect(
      within(agentCard("Private Ops")).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();

    await user.click(tab("Public"));
    await waitFor(() => {
      expect(agentCard("Research Agent")).toBeInTheDocument();
    });
    expect(
      within(agentCard("Research Agent")).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });
});
