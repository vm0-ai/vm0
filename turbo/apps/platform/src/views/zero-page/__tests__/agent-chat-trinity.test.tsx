/**
 * View tests for Trinity agent-chat integration (issue #10618).
 *
 * Covered:
 * - Launcher gated by `FeatureSwitchKey.Trinity`: hidden when off, visible when on
 * - Clicking the launcher navigates to `/agents/:id/talk`: composer leaves the
 *   DOM, subtitle + task-list region appears
 * - Clicking the launcher on the talk page navigates back to the chat page
 *
 * We don't mock the OpenAI Realtime / Ably path — the talk page setup kicks
 * off voice connection in the background. We assert the route transition and
 * the resulting rendered surface, not the WebRTC lifecycle (that's covered by
 * the signal tests).
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

async function waitForChatPage(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("chat-tagline")).toBeInTheDocument();
  });
}

describe("agent-chat page — Trinity launcher", () => {
  it("hides the mic launcher when Trinity is off", async () => {
    detachedSetupPage({ context, path: "/" });
    await waitForChatPage();
    expect(screen.queryByTestId("voice-chat-launcher")).not.toBeInTheDocument();
  });

  it("renders the mic launcher when Trinity is on", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { trinity: true },
    });
    await waitForChatPage();
    await waitFor(() => {
      expect(screen.getByTestId("voice-chat-launcher")).toBeInTheDocument();
    });
    // Composer is still the default surface until the user clicks the mic.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByTestId("voice-subtitle")).not.toBeInTheDocument();
  });

  it("click navigates to /talk: composer hides, subtitle shows; click again navigates back", async () => {
    const user = userEvent.setup();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { trinity: true },
    });
    await waitForChatPage();
    const chatLauncher = await waitFor(() => {
      return screen.getByTestId("voice-chat-launcher");
    });

    await user.click(chatLauncher);

    await waitFor(() => {
      expect(screen.getByTestId("voice-subtitle")).toBeInTheDocument();
    });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const talkLauncher = screen.getByTestId("voice-chat-launcher");
    expect(talkLauncher.getAttribute("aria-pressed")).toBe("true");

    await user.click(talkLauncher);

    await waitFor(() => {
      expect(screen.queryByTestId("voice-subtitle")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    const backLauncher = screen.getByTestId("voice-chat-launcher");
    expect(backLauncher.getAttribute("aria-pressed")).toBe("false");
  });
});
