import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

function setupChatWithRail(): void {
  mockResizeObserver();
  mockKeyboardNavigationThreads({ currentDetailTitle: null });
  detachedSetupPage({
    context,
    path: `/chats/${KEYBOARD_CURRENT_THREAD_ID}`,
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

function selectedCategoryLabel(): string | null {
  const selected = categoryTabs().find((tab) => {
    return tab.getAttribute("aria-selected") === "true";
  });
  return selected?.getAttribute("aria-label") ?? null;
}

// jsdom has no layout, so every section reports offsetTop 0. Scrolling away
// from 0 is therefore the only way to tell a rail that is following the feed
// from one still waiting for a jump that will never land.
function previewBarText(): string {
  const feed = document.querySelector("[data-chat-thread-emoji-feed]");
  const bar = feed?.nextElementSibling;
  if (!(bar instanceof HTMLElement)) {
    throw new Error("Expected the emoji name bar under the feed");
  }
  return bar.textContent ?? "";
}

function scrollEmojiFeed(scrollTop: number): void {
  const feed = document.querySelector("[data-chat-thread-emoji-feed]");
  if (!(feed instanceof HTMLElement)) {
    throw new Error("Expected the emoji feed to be rendered");
  }
  feed.scrollTop = scrollTop;
  expect(feed.scrollTop).toBe(scrollTop);
  fireEvent.scroll(feed);
}

// The emoji dataset is imported on demand, so the group tabs and their titled
// sections only appear once it resolves.
async function waitForCategories(): Promise<void> {
  await waitFor(() => {
    expect(categoryTab("Food & Drink")).toBeInTheDocument();
    expect(screen.getByText("Food & Drink")).toBeInTheDocument();
  });
}

describe("chat thread emoji category rail", () => {
  it("moves the highlight to the category the user picks from the rail", async () => {
    setupChatWithRail();
    await openEmojiPicker();
    await waitForCategories();

    expect(selectedCategoryLabel()).toBe("Frequently used");

    click(categoryTab("Food & Drink"));

    await waitFor(() => {
      expect(selectedCategoryLabel()).toBe("Food & Drink");
    });
  });

  it("keeps following the feed after a pick that scrolls nowhere", async () => {
    setupChatWithRail();
    await openEmojiPicker();
    await waitForCategories();

    // The feed already sits at the top, so picking the category pinned there
    // moves nothing and emits no scroll event. The rail must not wait for one.
    click(categoryTab("Frequently used"));
    await waitFor(() => {
      expect(selectedCategoryLabel()).toBe("Frequently used");
    });

    scrollEmojiFeed(300);

    await waitFor(() => {
      expect(selectedCategoryLabel()).not.toBe("Frequently used");
    });
  });

  it("moves between categories with the arrow keys", async () => {
    setupChatWithRail();
    await openEmojiPicker();
    await waitForCategories();

    const firstTab = categoryTab("Frequently used");
    firstTab.focus();
    expect(firstTab).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(firstTab, { key: "ArrowRight" });

    await waitFor(() => {
      expect(selectedCategoryLabel()).toBe("Smileys & Emotion");
    });
    expect(categoryTab("Smileys & Emotion")).toHaveFocus();
    // Only the selected tab stays in the tab order.
    expect(categoryTab("Frequently used")).toHaveAttribute("tabindex", "-1");
  });

  it("names the emoji the pointer is on", async () => {
    setupChatWithRail();
    await openEmojiPicker();
    await waitForCategories();

    expect(screen.getByText("Pick an emoji")).toBeInTheDocument();

    const grinningFace = await screen.findByLabelText("grinning face");
    fireEvent.mouseOver(grinningFace);

    await waitFor(() => {
      expect(screen.getByText(":grinning_face:")).toBeInTheDocument();
    });
    expect(screen.queryByText("Pick an emoji")).toBeNull();

    fireEvent.mouseOver(await screen.findByLabelText("watermelon"));

    await waitFor(() => {
      expect(screen.getByText(":watermelon:")).toBeInTheDocument();
    });
  });

  it("names a frequently used emoji by its product label, not as a shortcode", async () => {
    setupChatWithRail();
    await openEmojiPicker();
    await waitForCategories();

    // These nine are named by translated product labels rather than by the
    // emoji dataset, so wrapping them in shortcode colons would claim a
    // shortcode that does not exist — ":Done:" in en-US, ":完了:" in ja-JP.
    fireEvent.mouseOver(await screen.findByLabelText("Done"));

    await waitFor(() => {
      expect(previewBarText()).toContain("Done");
    });
    expect(previewBarText()).not.toContain(":Done:");
  });

  it("leaves the search results when a category is picked", async () => {
    setupChatWithRail();
    await openEmojiPicker();
    await waitForCategories();

    await fill(screen.getByLabelText("Search emoji"), "rocket");
    await waitFor(() => {
      expect(screen.queryByText("Food & Drink")).toBeNull();
    });

    click(categoryTab("Food & Drink"));

    await waitFor(() => {
      expect(screen.getByLabelText("Search emoji")).toHaveValue("");
      expect(screen.getByText("Food & Drink")).toBeInTheDocument();
    });
  });
});
