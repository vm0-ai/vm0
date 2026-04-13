import { describe, it, expect } from "vitest";
import { createStore } from "ccstate";
import { createChatThreadSignals } from "../create-chat-thread.ts";
import { createDraftSignals } from "../../zero-page/chat-draft.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScrollContainer(options: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
}): HTMLElement {
  const el = document.createElement("div");

  // JSDOM does not compute layout, so we define the geometry manually.
  Object.defineProperty(el, "scrollHeight", {
    get: () => {
      return options.scrollHeight;
    },
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    get: () => {
      return options.clientHeight;
    },
    configurable: true,
  });

  el.scrollTop = options.scrollTop ?? 0;
  return el;
}

function makeScrollContainerWithMessages(options: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
  userMessageOffsetTop?: number;
}): HTMLElement {
  const scrollEl = makeScrollContainer(options);

  // Add a message container with a user message so scrollToMessages can find a target.
  const container = document.createElement("div");
  container.dataset.messageContainer = "";

  const userMsg = document.createElement("div");
  userMsg.dataset.role = "user";
  Object.defineProperty(userMsg, "offsetTop", {
    get: () => {
      return options.userMessageOffsetTop ?? 0;
    },
    configurable: true,
  });

  container.append(userMsg);
  scrollEl.append(container);
  return scrollEl;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// CHAT-SCROLL-001: autoScroll$ gate — does NOT scroll when far from bottom
describe("createChatThreadSignals - autoScroll$ near-bottom threshold", () => {
  it("does not scroll when distance from bottom exceeds 80px (CHAT-SCROLL-001)", () => {
    const store = createStore();
    const draft = createDraftSignals();
    const signals = createChatThreadSignals("thread-scroll-001", draft);

    const scrollEl = makeScrollContainerWithMessages({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 200, // distanceFromBottom = 1000 - 200 - 300 = 500 > 80
    });

    store.set(signals.setScrollContainer$, scrollEl);
    store.set(signals.autoScroll$);

    // scrollTop should remain unchanged — we are far from the bottom
    expect(scrollEl.scrollTop).toBe(200);
  });
});

// CHAT-SCROLL-002: autoScroll$ gate — DOES scroll when close to bottom
describe("createChatThreadSignals - autoScroll$ scrolls when near bottom", () => {
  it("calls scrollToMessages when distance from bottom is within 80px (CHAT-SCROLL-002)", () => {
    const store = createStore();
    const draft = createDraftSignals();
    const signals = createChatThreadSignals("thread-scroll-002", draft);

    const scrollEl = makeScrollContainerWithMessages({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 660, // distanceFromBottom = 1000 - 660 - 300 = 40 ≤ 80
      userMessageOffsetTop: 0,
    });

    store.set(signals.setScrollContainer$, scrollEl);
    store.set(signals.autoScroll$);

    // scrollToMessages should have run — scrollTop is now set to the user message offset
    // (offsetTop = 0, container.offsetTop = 0 → scrollTop = 0)
    expect(scrollEl.scrollTop).toBe(0);
  });
});

// CHAT-SCROLL-003: forceScrollToBottom$ always scrolls regardless of distance
describe("createChatThreadSignals - forceScrollToBottom$ ignores threshold", () => {
  it("scrolls to messages even when user is far from the bottom (CHAT-SCROLL-003)", () => {
    const store = createStore();
    const draft = createDraftSignals();
    const signals = createChatThreadSignals("thread-scroll-003", draft);

    const scrollEl = makeScrollContainerWithMessages({
      scrollHeight: 2000,
      clientHeight: 300,
      scrollTop: 800, // distanceFromBottom = 2000 - 800 - 300 = 900 >> 80
      userMessageOffsetTop: 0,
    });

    store.set(signals.setScrollContainer$, scrollEl);
    store.set(signals.forceScrollToBottom$);

    // forceScrollToBottom$ calls scrollToMessages unconditionally.
    // userTop = offsetTop(0) - container.offsetTop(0) = 0, so scrollTop is set to 0.
    // This confirms scrollToMessages ran despite being far from the bottom.
    expect(scrollEl.scrollTop).toBe(0);
  });
});
