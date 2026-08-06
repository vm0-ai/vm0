import { sharedThreadsContract } from "@vm0/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000701";
const USER_EVENT_ID = "10000000-0000-4000-8000-000000000701";
const ASSISTANT_EVENT_ID = "20000000-0000-4000-8000-000000000701";
const RUN_ID = "d0000000-0000-4000-a000-000000000701";
const SHARED_THREAD_ID = "30000000-0000-4000-8000-000000000701";

function buttonsByText(text: string): readonly HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    const normalizedText = button.textContent?.replace(/\s+/g, " ").trim();
    return (
      normalizedText === text || button.getAttribute("aria-label") === text
    );
  });
}

function buttonByText(text: string): HTMLElement {
  const button = buttonsByText(text)[0];
  if (!button) {
    throw new Error(`Expected a ${text} button`);
  }
  return button;
}

function mockShareableThread() {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Shareable conversation",
    chatEvents: [
      {
        id: USER_EVENT_ID,
        role: "user",
        content: "Shareable prompt",
        runId: RUN_ID,
        createdAt: "2026-08-06T10:00:00Z",
      },
      {
        id: ASSISTANT_EVENT_ID,
        role: "assistant",
        content: "Shareable answer",
        runId: RUN_ID,
        createdAt: "2026-08-06T10:00:01Z",
      },
    ],
  });
}

describe("chat thread sharing", () => {
  it("selects visual message groups and creates a public snapshot", async () => {
    const user = userEvent.setup({ delay: null });
    let submittedThreadId: string | null = null;
    let submittedEventIds: readonly string[] = [];
    mockShareableThread();
    context.mocks.api(
      sharedThreadsContract.create,
      ({ params, body, respond }) => {
        submittedThreadId = params.threadId;
        submittedEventIds = body.eventIds;
        return respond(201, { id: SHARED_THREAD_ID });
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.SharedThreadSharing]: true,
      },
    });

    await screen.findByText("Shareable prompt");
    const startButtons = buttonsByText("Share messages");
    expect(startButtons.length).toBeGreaterThan(0);
    await user.click(startButtons[0]!);

    const initialCheckboxes = await screen.findAllByRole("checkbox");
    expect(initialCheckboxes.length).toBeGreaterThan(0);
    expect(
      initialCheckboxes.every((checkbox) => {
        return checkbox.dataset.state === "unchecked";
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);

    const promptGroup = screen
      .getByText("Shareable prompt")
      .closest("[data-chat-share-selectable-group]");
    if (!promptGroup) {
      throw new Error("Expected the prompt inside a selectable visual group");
    }
    await user.click(promptGroup);
    await waitFor(() => {
      expect(
        screen.getAllByRole("checkbox").some((checkbox) => {
          return checkbox.dataset.state === "checked";
        }),
      ).toBeTruthy();
    });

    const bodySelectedCheckbox = screen
      .getAllByRole("checkbox")
      .find((checkbox) => {
        return checkbox.dataset.state === "checked";
      });
    if (!bodySelectedCheckbox) {
      throw new Error("Expected the message body to select its visual group");
    }
    await user.click(bodySelectedCheckbox);
    await waitFor(() => {
      expect(bodySelectedCheckbox).toHaveAttribute("data-state", "unchecked");
    });
    await user.click(bodySelectedCheckbox);

    for (const checkbox of screen.getAllByRole("checkbox")) {
      if (checkbox.dataset.state !== "checked") {
        await user.click(checkbox);
      }
    }
    await waitFor(() => {
      expect(screen.getAllByText("2 selected").length).toBeGreaterThan(0);
    });

    await user.click(buttonByText("Share"));

    const link = await screen.findByRole("textbox", {
      name: "Shared conversation link",
    });
    expect(link).toHaveValue(
      `${window.location.origin}/share/threads/${SHARED_THREAD_ID}`,
    );
    expect(submittedThreadId).toBe(THREAD_ID);
    expect(submittedEventIds).toStrictEqual([
      USER_EVENT_ID,
      ASSISTANT_EVENT_ID,
    ]);
  });

  it("hides sharing entry points when the feature switch is disabled", async () => {
    mockShareableThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.SharedThreadSharing]: false,
      },
    });

    await expect(
      screen.findByText("Shareable prompt"),
    ).resolves.toBeInTheDocument();
    expect(buttonsByText("Share messages")).toHaveLength(0);
  });
});
