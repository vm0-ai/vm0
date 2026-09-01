import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

warmMermaidParser();

describe("built-in welcome thread", () => {
  it("stays closed until selected and renders native rich-text deliverables without thread actions", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.BuiltInWelcomeThread]: true,
      },
    });

    const chatList = await screen.findByTestId("chat-list-column");
    const row = await within(chatList).findByTestId(
      "built-in-welcome-thread-row",
    );
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(screen.queryByTestId("welcome-thread-page")).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId("chat-thread-menu-trigger"),
    ).not.toBeInTheDocument();

    const welcomeLink = queryAllByRoleFast("link", row).find((candidate) => {
      return candidate.textContent === "Welcome to Zero";
    });
    if (!welcomeLink) {
      throw new Error("Welcome thread link not found");
    }
    click(welcomeLink);

    const page = await screen.findByTestId("welcome-thread-page");
    const content = within(page).getByTestId("welcome-thread-content");
    expect(pathname()).toBe("/chats/welcome");
    await waitFor(() => {
      expect(document.title).toBe("Welcome to Zero | VM0");
    });
    expect(
      within(page).getByRole("heading", { name: "Hi, I'm Zero" }),
    ).toBeInTheDocument();
    expect(
      within(content).getByRole("img", {
        name: "Campaign visual delivered by Zero",
      }),
    ).toBeInTheDocument();
    expect(
      within(content).getByRole("img", {
        name: "Presentation delivered by Zero",
      }),
    ).toBeInTheDocument();
    expect(content.querySelector("video")).toBeInTheDocument();
    expect(
      within(content).getByText("Qualify inbound leads"),
    ).toBeInTheDocument();
    expect(
      within(content).getByRole("heading", {
        name: "How to work with me as a team",
      }),
    ).toBeInTheDocument();
    expect(
      within(content).getByRole("heading", { name: "Talk to me in Slack" }),
    ).toBeInTheDocument();
    expect(within(content).getByText("/okou")).toBeInTheDocument();
    const slackSetupLink = queryAllByRoleFast("link", content).find(
      (candidate) => {
        return candidate.textContent === "Set up Slack";
      },
    );
    expect(slackSetupLink).toHaveAttribute(
      "href",
      `${window.location.origin}/works`,
    );
    expect(
      within(page).getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      // the collaboration loop plus the team-workflow and Slack-routing diagrams
      expect(content.querySelectorAll(".mermaid-block")).toHaveLength(3);
    });
  });

  it("hides the entry and redirects the built-in route while the feature is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/chats/welcome",
      featureSwitches: {
        [FeatureSwitchKey.BuiltInWelcomeThread]: false,
      },
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });
    expect(
      screen.queryByTestId("built-in-welcome-thread-row"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("welcome-thread-page")).not.toBeInTheDocument();
  });
});
