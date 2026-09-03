import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function prepareDefaultAgent(): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
}

describe("new ui feature switch", () => {
  it("leaves the app shell on the previous surfaces when the switch is off", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await screen.findByRole("textbox", { name: "Message" });

    expect(document.documentElement.dataset.newUi).toBeUndefined();
  });

  it("moves the app shell onto the card layout when the switch is on", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.NewUi]: true },
    });

    await screen.findByRole("textbox", { name: "Message" });

    await waitFor(() => {
      expect(document.documentElement.dataset.newUi).toBe("");
    });
  });

  it("moves the minimal shell too so directed pages match the app", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?connectorSlug=slack&permission=admin.analytics%3Aread&action=approve`,
      featureSwitches: { [FeatureSwitchKey.NewUi]: true },
    });

    await screen.findByText("Unknown permission action: approve");

    await waitFor(() => {
      expect(document.documentElement.dataset.newUi).toBe("");
    });
  });

  // The chat column and the gutter around the workspace card are one surface
  // under the new shell, so the column's own right edge has to go: kept, it
  // would run parallel to the card's border eight pixels away.
  it("keeps the chat column's divider while the switch is off", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const column = await screen.findByTestId("chat-list-column");

    expect(column.className).toContain("border-r-[0.7px]");
  });

  it("drops the chat column's divider once the switch is on", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.NewUi]: true },
    });

    const column = await screen.findByTestId("chat-list-column");

    await waitFor(() => {
      expect(column.className).not.toContain("border-r-[0.7px]");
    });
  });
});
