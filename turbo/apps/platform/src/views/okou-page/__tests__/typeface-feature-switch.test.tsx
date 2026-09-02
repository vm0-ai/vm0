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

describe("geist typeface feature switch", () => {
  it("keeps the default typeface in the app shell when the switch is off", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await screen.findByRole("textbox", { name: "Message" });

    expect(document.documentElement.dataset.typeface).toBeUndefined();
  });

  it("switches the app shell to geist when the switch is on", async () => {
    prepareDefaultAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.GeistTypeface]: true },
    });

    await screen.findByRole("textbox", { name: "Message" });

    await waitFor(() => {
      expect(document.documentElement.dataset.typeface).toBe("geist");
    });
  });

  it("switches the minimal shell to geist so directed pages match the app", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/permissions?connectorSlug=slack&permission=admin.analytics%3Aread&action=approve`,
      featureSwitches: { [FeatureSwitchKey.GeistTypeface]: true },
    });

    await screen.findByText("Unknown permission action: approve");

    await waitFor(() => {
      expect(document.documentElement.dataset.typeface).toBe("geist");
    });
  });
});
