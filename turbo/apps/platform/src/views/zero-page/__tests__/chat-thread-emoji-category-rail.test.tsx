import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  detachedSetupPage,
  KEYBOARD_CURRENT_THREAD_ID,
  chatComposerTextarea,
  mockKeyboardNavigationThreads,
  mockResizeObserver,
} from "./chat-lifecycle-test-helpers.ts";

function setupChatWithRail(railEnabled: boolean): void {
  mockResizeObserver();
  mockKeyboardNavigationThreads({ currentDetailTitle: null });
  detachedSetupPage({
    context,
    path: `/chats/${KEYBOARD_CURRENT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.EmojiPickerCategoryRail]: railEnabled,
    },
  });
}

async function openEmojiPicker(): Promise<void> {
  await waitFor(() => {
    expect(chatComposerTextarea()).toBeInTheDocument();
  });
  const composer = chatComposerTextarea();
  composer.focus();
  fireEvent.keyDown(composer, { key: "F2", shiftKey: true });
  await screen.findByLabelText("Search emoji");
}

function categoryTabs(): HTMLElement[] {
  return queryAllByRoleFast("tab");
}

function categoryTab(label: string): HTMLElement {
  const tab = categoryTabs().find((element) => {
    return element.getAttribute("aria-label") === label;
  });
  if (!tab) {
    throw new Error(`Expected an emoji category tab labelled ${label}`);
  }
  return tab;
}

function emojiSection(category: string): Element | null {
  return document.querySelector(
    `[data-chat-thread-emoji-section="${category}"]`,
  );
}

// The emoji dataset is imported on demand, so the group tabs only appear once
// it resolves.
async function waitForCategoryTabs(): Promise<void> {
  await waitFor(() => {
    expect(categoryTab("Food & Drink")).toBeInTheDocument();
  });
}

describe("chat thread emoji category rail", () => {
  it("moves the highlight to the category the user picks from the rail", async () => {
    setupChatWithRail(true);
    await openEmojiPicker();
    await waitForCategoryTabs();

    expect(categoryTab("Frequently used")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Every tab has a titled section to scroll to.
    expect(emojiSection("Food & Drink")).not.toBeNull();

    click(categoryTab("Food & Drink"));

    await waitFor(() => {
      expect(categoryTab("Food & Drink")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    expect(categoryTab("Frequently used")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("leaves the search results when a category is picked", async () => {
    setupChatWithRail(true);
    await openEmojiPicker();
    await waitForCategoryTabs();

    await fill(screen.getByLabelText("Search emoji"), "rocket");
    await waitFor(() => {
      expect(emojiSection("Food & Drink")).toBeNull();
    });

    click(categoryTab("Food & Drink"));

    await waitFor(() => {
      expect(screen.getByLabelText("Search emoji")).toHaveValue("");
      expect(emojiSection("Food & Drink")).not.toBeNull();
    });
  });

  it("keeps the picker railless while the feature switch is off", async () => {
    setupChatWithRail(false);
    await openEmojiPicker();
    await screen.findByText("Frequently used");

    expect(categoryTabs()).toHaveLength(0);
  });
});
