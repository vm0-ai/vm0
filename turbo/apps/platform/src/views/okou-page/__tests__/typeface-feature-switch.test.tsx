import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
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

test("The app shell keeps its default typeface when Geist is unavailable", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByRole("textbox", { name: "Message" });
  expect(document.documentElement.dataset.typeface).toBeUndefined();
});

test("The app shell uses Geist when the typeface is available", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.GeistTypeface]: true },
  });

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(document.documentElement.dataset.typeface).toBe("geist");
  });
});

test("A directed page uses Geist with the rest of the app", async () => {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/permissions?connectorSlug=slack&permission=admin.analytics%3Aread&action=approve`,
    featureSwitches: { [FeatureSwitchKey.GeistTypeface]: true },
  });

  await screen.findByText("Unknown permission action: approve");

  await waitFor(() => {
    expect(document.documentElement.dataset.typeface).toBe("geist");
  });
});
