import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
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

test("The current shell remains unchanged when the new interface is unavailable", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByRole("textbox", { name: "Message" });
  const chatList = await screen.findByTestId("chat-list-column");
  expect(document.documentElement.dataset.newUi).toBeUndefined();
  expect(chatList).toHaveClass("border-r-[0.7px]");
});

test("A user with the new interface sees one continuous workspace shell", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.NewUi]: true },
  });

  await screen.findByRole("textbox", { name: "Message" });
  const chatList = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(document.documentElement.dataset.newUi).toBe("");
  });
  expect(chatList).not.toHaveClass("border-r-[0.7px]");
  expect(document.querySelector(".zero-workspace-card")).toBeVisible();
});
