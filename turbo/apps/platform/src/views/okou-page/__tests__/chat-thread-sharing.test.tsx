import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
const ASSISTANT_EVENT_IDS = [
  "20000000-0000-4000-8000-000000000801",
  "20000000-0000-4000-8000-000000000802",
  "20000000-0000-4000-8000-000000000803",
] as const;
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

function checkedCheckboxes(): HTMLElement[] {
  return screen.getAllByRole("checkbox").filter((checkbox) => {
    return checkbox.getAttribute("aria-checked") === "true";
  });
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

    await screen.findAllByRole("navigation", { name: "Sidebar" });
    await screen.findByRole("textbox", { name: "Message" });
    await screen.findByText("Shareable prompt");
    const startButtons = buttonsByText("Share messages");
    expect(startButtons.length).toBeGreaterThan(0);
    await user.click(startButtons[0]!);

    const initialCheckboxes = await screen.findAllByRole("checkbox");
    expect(initialCheckboxes.length).toBeGreaterThan(0);
    for (const checkbox of initialCheckboxes) {
      expect(checkbox).not.toBeChecked();
    }
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);

    const promptGroup = screen
      .getByText("Shareable prompt")
      .closest("[data-chat-share-selectable-group]");
    if (!promptGroup) {
      throw new Error("Expected the prompt inside a selectable visual group");
    }
    await user.click(promptGroup);
    await waitFor(() => {
      expect(checkedCheckboxes().length).toBeGreaterThan(0);
    });

    const bodySelectedCheckbox = checkedCheckboxes()[0];
    if (!bodySelectedCheckbox) {
      throw new Error("Expected the message body to select its visual group");
    }
    await user.click(bodySelectedCheckbox);
    await waitFor(() => {
      expect(bodySelectedCheckbox).not.toBeChecked();
    });
    await user.click(bodySelectedCheckbox);

    for (const checkbox of screen.getAllByRole("checkbox")) {
      if (checkbox.getAttribute("aria-checked") !== "true") {
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

  it("counts a multi-message group as one selection", async () => {
    const user = userEvent.setup({ delay: null });
    let submittedEventIds: readonly string[] = [];
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      threadTitle: "Multi answer conversation",
      chatEvents: [
        {
          id: USER_EVENT_ID,
          role: "user",
          content: "Shareable prompt",
          runId: RUN_ID,
          createdAt: "2026-08-06T10:00:00Z",
        },
        ...ASSISTANT_EVENT_IDS.map((id, index) => {
          return {
            id,
            role: "assistant" as const,
            content: `Shareable answer ${String(index + 1)}`,
            runId: RUN_ID,
            createdAt: `2026-08-06T10:00:0${String(index + 1)}Z`,
          };
        }),
      ],
      activeRunIds: [RUN_ID],
    });
    context.mocks.api(sharedThreadsContract.create, ({ body, respond }) => {
      submittedEventIds = body.eventIds;
      return respond(201, { id: SHARED_THREAD_ID });
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.SharedThreadSharing]: true,
      },
    });

    await screen.findByText("Shareable answer 3");
    await user.click(buttonByText("Share messages"));

    const answerGroup = screen
      .getByText("Shareable answer 3")
      .closest("[data-chat-share-selectable-group]");
    const checkbox =
      answerGroup?.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) {
      throw new Error("Expected the assistant group selection checkbox");
    }

    await user.click(checkbox);

    // One tick over a group holding three answers is one selection, not three.
    await waitFor(() => {
      expect(screen.getAllByText("1 selected").length).toBeGreaterThan(0);
    });
    expect(checkedCheckboxes()).toHaveLength(1);

    await user.click(buttonByText("Share"));
    await screen.findByRole("textbox", { name: "Shared conversation link" });
    expect([...submittedEventIds].sort()).toStrictEqual(
      [...ASSISTANT_EVENT_IDS].sort(),
    );
  });

  it("keeps an oversized visual message group unselected", async () => {
    const user = userEvent.setup({ delay: null });
    const oversizedText = "界".repeat(512 * 1024 + 1);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      threadTitle: "Oversized conversation",
      chatEvents: [
        {
          id: USER_EVENT_ID,
          role: "user",
          content: oversizedText,
          runId: RUN_ID,
          createdAt: "2026-08-06T10:00:00Z",
        },
        {
          id: ASSISTANT_EVENT_ID,
          role: "assistant",
          content: "Small answer after the oversized prompt",
          runId: RUN_ID,
          createdAt: "2026-08-06T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.SharedThreadSharing]: true,
      },
    });

    await screen.findByText("Small answer after the oversized prompt");
    await user.click(buttonByText("Share messages"));

    const oversizedGroup = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-chat-share-selectable-group]",
      ),
    ].find((group) => {
      return (group.textContent?.length ?? 0) > 512 * 1024;
    });
    const checkbox =
      oversizedGroup?.querySelector<HTMLElement>('[role="checkbox"]');
    if (!checkbox) {
      throw new Error("Expected the oversized message selection checkbox");
    }

    await user.click(checkbox);

    await expect(
      screen.findByText("Select fewer messages to share"),
    ).resolves.toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
  });
});
