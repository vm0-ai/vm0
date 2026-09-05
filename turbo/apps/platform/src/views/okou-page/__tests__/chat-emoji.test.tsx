import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";

function setupEmojiPage(): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Emoji planning",
  });
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function categoryTab(label: string): HTMLButtonElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!(tab instanceof HTMLButtonElement)) {
    throw new Error(`Emoji category tab not found: ${label}`);
  }
  return tab;
}

function emojiButton(label: string): HTMLButtonElement {
  const button = document.querySelector(
    `[data-chat-thread-emoji][aria-label="${label}"]`,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Emoji button not found: ${label}`);
  }
  return button;
}

function emojiFeed(): HTMLElement {
  const feed = document.querySelector("[data-chat-thread-emoji-feed]");
  if (!(feed instanceof HTMLElement)) {
    throw new Error("Emoji feed not found");
  }
  return feed;
}

async function openEmojiPicker(): Promise<HTMLInputElement> {
  await setupEmojiPage();
  await waitFor(() => {
    expect(buttonByLabel("Change icon")).toBeInTheDocument();
  });

  click(buttonByLabel("Change icon"));

  const searchInput = await screen.findByRole("textbox", {
    name: "Search emoji",
  });
  if (!(searchInput instanceof HTMLInputElement)) {
    throw new Error("Emoji search is not an input");
  }
  return searchInput;
}

function setCategoryLayout(feed: HTMLElement): void {
  const sections = Array.from(
    feed.querySelectorAll<HTMLElement>("[data-chat-thread-emoji-section]"),
  );
  for (const [index, section] of sections.entries()) {
    Object.defineProperty(section, "offsetTop", {
      configurable: true,
      value: index * 100,
    });
  }
}

function nextAnimationFrame(): Promise<void> {
  const frame = createDeferredPromise<void>(context.signal);
  window.requestAnimationFrame(() => {
    frame.resolve();
  });
  return frame.promise;
}

test("Choosing an emoji category exits search results", async () => {
  const user = userEvent.setup();
  const searchInput = await openEmojiPicker();
  await user.type(searchInput, "watermelon");
  await waitFor(() => {
    expect(searchInput).toHaveValue("watermelon");
    expect(emojiButton("watermelon")).toBeInTheDocument();
  });
  expect(screen.queryByText("Food & Drink")).toBeNull();

  click(categoryTab("Food & Drink"));

  await waitFor(() => {
    expect(searchInput).toHaveValue("");
    expect(screen.getByText("Food & Drink")).toBeInTheDocument();
    expect(categoryTab("Food & Drink")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test("Choosing an emoji category updates the category rail", async () => {
  await openEmojiPicker();
  const feed = emojiFeed();
  setCategoryLayout(feed);
  Object.defineProperties(feed, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1200 },
    scrollTo: {
      configurable: true,
      value: ({ top }: ScrollToOptions) => {
        feed.scrollTop = top ?? 0;
      },
    },
  });

  click(categoryTab("Food & Drink"));
  await nextAnimationFrame();

  expect(categoryTab("Food & Drink")).toHaveAttribute("aria-selected", "true");
  expect(categoryTab("Frequently used")).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(screen.getByText("Food & Drink")).toBeInTheDocument();
  expect(feed.scrollTop).toBeGreaterThan(0);
});

test("Emoji categories can be navigated with arrow keys", async () => {
  await openEmojiPicker();
  const categoryList = screen.getByRole("tablist", {
    name: "Emoji categories",
  });
  const frequent = categoryTab("Frequently used");
  const smileys = categoryTab("Smileys & Emotion");
  frequent.focus();

  fireEvent.keyDown(categoryList, { key: "ArrowRight" });

  await waitFor(() => {
    expect(smileys).toHaveAttribute("aria-selected", "true");
    expect(smileys).toHaveFocus();
  });
  expect(smileys).toHaveAttribute("tabindex", "0");
  expect(frequent).toHaveAttribute("tabindex", "-1");
  expect(
    queryAllByRoleFast("tab").filter((tab) => {
      return tab.getAttribute("tabindex") === "0";
    }),
  ).toHaveLength(1);
});

test("The emoji picker names the emoji under the pointer", async () => {
  await openEmojiPicker();
  expect(screen.getByText("Pick an emoji")).toBeInTheDocument();

  fireEvent.mouseOver(emojiButton("grinning face"));

  await waitFor(() => {
    expect(screen.getByText(":grinning_face:")).toBeInTheDocument();
  });

  fireEvent.mouseOver(emojiButton("watermelon"));

  await waitFor(() => {
    expect(screen.getByText(":watermelon:")).toBeInTheDocument();
  });
  expect(screen.queryByText(":grinning_face:")).toBeNull();
});

test("The emoji category rail resumes following manual scrolling", async () => {
  await openEmojiPicker();
  const feed = emojiFeed();
  setCategoryLayout(feed);
  expect(categoryTab("Frequently used")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  click(categoryTab("Frequently used"));
  await nextAnimationFrame();
  feed.scrollTop = 100;
  fireEvent.scroll(feed);

  await waitFor(() => {
    expect(categoryTab("Smileys & Emotion")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  expect(categoryTab("Frequently used")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});
