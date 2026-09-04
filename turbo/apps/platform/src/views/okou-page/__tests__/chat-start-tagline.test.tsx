import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupAgentChatPage$ } from "../../../signals/okou-page/agent-chat-page-setup.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

test("A completed chat tagline survives setup of the same route", async () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  context.signal.addEventListener(
    "abort",
    () => {
      random.mockRestore();
    },
    { once: true },
  );
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const tagline = await screen.findByTestId("chat-tagline");
  const completeText = tagline.getAttribute("aria-label");
  if (!completeText) {
    throw new Error("Expected an accessible chat tagline");
  }
  await waitFor(() => {
    expect(tagline).toHaveTextContent(completeText);
  });

  await act(async () => {
    await context.store.set(setupAgentChatPage$, context.signal);
  });

  expect(screen.getByTestId("chat-tagline")).toHaveTextContent(completeText);
});
