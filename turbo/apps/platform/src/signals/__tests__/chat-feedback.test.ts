import { afterEach, describe, expect, it } from "vitest";

import {
  captureFeedbackSelection$,
  startFeedback$,
  removeFeedbackItem$,
  dismissFeedback$,
  feedbackItemsValue$,
  feedbackThreadIdValue$,
} from "../zero-page/chat-feedback.ts";
import { testContext } from "./test-helpers.ts";

// Render a minimal assistant bubble inside a thread container, matching the DOM
// the inline-feedback selection logic reads (the thread id and bubble class).
function mountThreadBubble(threadId: string, text: string): HTMLElement {
  const section = document.createElement("section");
  section.dataset.chatThreadContainerId = threadId;
  const bubble = document.createElement("div");
  bubble.className = "zero-chat-bubble-assistant";
  bubble.textContent = text;
  section.appendChild(bubble);
  document.body.appendChild(section);
  return bubble;
}

function selectContents(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("inline feedback thread scoping", () => {
  const ctx = testContext();

  it("binds a feedback draft to the thread it was selected in", () => {
    const bubble = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubble);

    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);

    expect(ctx.store.get(feedbackThreadIdValue$)).toBe("thread-a");
    expect(ctx.store.get(feedbackItemsValue$)).toHaveLength(1);
  });

  it("starts a fresh stack when feedback moves to another thread", () => {
    const bubbleA = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubbleA);
    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);

    // Picking a passage in a different thread must not append to thread A's
    // draft — the comment only follows its own chat thread.
    const bubbleB = mountThreadBubble("thread-b", "Reply from thread B");
    selectContents(bubbleB);
    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);

    const items = ctx.store.get(feedbackItemsValue$);
    expect(ctx.store.get(feedbackThreadIdValue$)).toBe("thread-b");
    expect(items).toHaveLength(1);
    expect(items[0]?.quote).toBe("Reply from thread B");
  });

  it("clears the owning thread when feedback is dismissed", () => {
    const bubble = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubble);
    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);
    expect(ctx.store.get(feedbackThreadIdValue$)).toBe("thread-a");

    ctx.store.set(dismissFeedback$);

    expect(ctx.store.get(feedbackThreadIdValue$)).toBeNull();
    expect(ctx.store.get(feedbackItemsValue$)).toHaveLength(0);
  });
});

// happy-dom has no CSS Custom Highlight API, so stub the pieces the highlight
// manager touches and inspect the registry it writes to.
class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

interface HighlightGlobals {
  Highlight?: unknown;
  CSS?: { highlights?: Map<string, FakeHighlight> };
}

describe("inline feedback source highlight", () => {
  const ctx = testContext();
  const globals = globalThis as unknown as HighlightGlobals;
  const originalHighlight = globals.Highlight;
  const originalCss = globals.CSS;

  afterEach(() => {
    globals.Highlight = originalHighlight;
    globals.CSS = originalCss;
  });

  it("highlights the drafted passage and clears it on remove", () => {
    // Reset the module-level highlight ranges left by earlier tests.
    ctx.store.set(dismissFeedback$);
    const highlights = new Map<string, FakeHighlight>();
    globals.Highlight = FakeHighlight;
    globals.CSS = { highlights };

    const bubble = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubble);
    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);

    const registered = highlights.get("zero-feedback");
    expect(registered).toBeDefined();
    expect(registered?.ranges).toHaveLength(1);

    const id = ctx.store.get(feedbackItemsValue$)[0]?.id;
    expect(id).toBeDefined();
    ctx.store.set(removeFeedbackItem$, id as number);

    expect(highlights.has("zero-feedback")).toBeFalsy();
  });
});
