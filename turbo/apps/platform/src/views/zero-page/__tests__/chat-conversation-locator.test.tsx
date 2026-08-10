import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000806";

/** Ten alternating turns: past the locator's turn floor on its own. */
function conversation(): MockChatEventInput[] {
  const events: MockChatEventInput[] = [];
  for (let index = 0; index < 5; index += 1) {
    const minute = String(index).padStart(2, "0");
    events.push(
      {
        id: `locator-prompt-${index}`,
        eventType: "input.prompt",
        role: "user",
        content: `Question ${index}`,
        createdAt: `2026-06-09T10:${minute}:00Z`,
      },
      {
        id: `locator-reply-${index}`,
        eventType: "output.message",
        role: "assistant",
        content: `Answer ${index}`,
        runId: `run-locator-${index}`,
        createdAt: `2026-06-09T10:${minute}:30Z`,
      },
    );
  }
  return events;
}

function renderThread(enabled: boolean): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Conversation locator",
    chatEvents: conversation(),
  });
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatConversationLocator]: enabled,
    },
  });
}

describe("chat conversation locator", () => {
  it("stays out of the thread while the feature switch is off", async () => {
    renderThread(false);

    await screen.findByText("Answer 4");
    expect(document.querySelector("[data-conversation-locator]")).toBeNull();
    expect(
      document.querySelector("[data-conversation-locator-preview]"),
    ).toBeNull();
  });

  it("mounts the rail and its preview card once the switch is on", async () => {
    renderThread(true);

    await screen.findByText("Answer 4");
    const rail = await waitFor(() => {
      const element = document.querySelector("[data-conversation-locator]");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    // The rail is a pointer-only shortcut to turns the thread already lists in
    // order, so it must not add a control to the accessibility tree.
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    expect(
      document.querySelector("[data-conversation-locator-preview]"),
    ).not.toBeNull();
  });

  it("draws no ticks until the thread outgrows the viewport", async () => {
    renderThread(true);

    await screen.findByText("Answer 4");
    const rail = await waitFor(() => {
      const element = document.querySelector("[data-conversation-locator]");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    // Turn count alone does not open the rail: the thread also has to be
    // taller than a few viewports, and an unlaid-out container never is.
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(0);
    expect(rail.className).toContain("opacity-0");
  });
});
