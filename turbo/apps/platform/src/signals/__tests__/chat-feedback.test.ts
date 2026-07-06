import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "@vm0/ui/components/ui/sonner";

import {
  captureFeedbackSelection$,
  closeFeedbackSelectionToolbar$,
  startFeedback$,
  removeFeedbackItem$,
  dismissFeedback$,
  feedbackItemsValue$,
  feedbackSelectionValue$,
  feedbackThreadIdValue$,
  setFeedbackSelectionToolbarRef$,
} from "../zero-page/chat-feedback.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";
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

function dispatchShortcut(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  document.dispatchEvent(event);
  return event;
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

  it("carries pending composer text into the first comment's note", () => {
    // Text the user already typed before quoting must survive: the feedback
    // rows replace the textarea, so it moves into the new comment's note.
    const { draft } = ctx.store.set(ensureDraft$, "thread-a");
    ctx.store.set(draft.setInput$, "please fix this");

    const bubble = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubble);
    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);

    const items = ctx.store.get(feedbackItemsValue$);
    expect(items).toHaveLength(1);
    expect(items[0]?.note).toBe("please fix this");
    // The text left the composer so it is not also re-sent as a draft.
    expect(ctx.store.get(draft.input$)).toBe("");
  });

  it("only carries pending text into the first comment of a stack", () => {
    const { draft } = ctx.store.set(ensureDraft$, "thread-a");
    ctx.store.set(draft.setInput$, "please fix this");

    const bubble = mountThreadBubble("thread-a", "First passage");
    selectContents(bubble);
    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);

    const second = mountThreadBubble("thread-a", "Second passage");
    selectContents(second);
    ctx.store.set(captureFeedbackSelection$);
    ctx.store.set(startFeedback$);

    const items = ctx.store.get(feedbackItemsValue$);
    expect(items).toHaveLength(2);
    expect(items[0]?.note).toBe("please fix this");
    expect(items[1]?.note).toBe("");
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

  it("scopes feedback selection shortcuts to the toolbar reset signal", () => {
    const bubble = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubble);
    ctx.store.set(captureFeedbackSelection$);
    expect(ctx.store.get(feedbackSelectionValue$)).not.toBeNull();

    const toolbarScope = document.createElement("span");
    const cleanup = ctx.store.set(
      setFeedbackSelectionToolbarRef$,
      toolbarScope,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    const event = dispatchShortcut("f");

    expect(event.defaultPrevented).toBeTruthy();
    expect(ctx.store.get(feedbackSelectionValue$)).toBeNull();
    expect(ctx.store.get(feedbackItemsValue$)).toHaveLength(1);

    const second = mountThreadBubble("thread-a", "Second passage");
    selectContents(second);
    ctx.store.set(captureFeedbackSelection$);
    dispatchShortcut("f");

    expect(ctx.store.get(feedbackItemsValue$)).toHaveLength(1);
    dialog.remove();
    cleanup?.();
  });

  it("closes the toolbar with Escape", () => {
    const bubble = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubble);
    ctx.store.set(captureFeedbackSelection$);
    expect(ctx.store.get(feedbackSelectionValue$)).not.toBeNull();

    const toolbarScope = document.createElement("span");
    const cleanup = ctx.store.set(
      setFeedbackSelectionToolbarRef$,
      toolbarScope,
    );
    const event = dispatchShortcut("Escape");

    expect(event.defaultPrevented).toBeTruthy();
    expect(ctx.store.get(feedbackSelectionValue$)).toBeNull();
    cleanup?.();
  });

  it("copies the selected passage, closes the toolbar, and shows a toast", async () => {
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const successToast = vi.spyOn(toast, "success");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    let cleanup: (() => void) | undefined;

    try {
      const bubble = mountThreadBubble("thread-a", "Reply from thread A");
      selectContents(bubble);
      ctx.store.set(captureFeedbackSelection$);

      const toolbarScope = document.createElement("span");
      cleanup = ctx.store.set(setFeedbackSelectionToolbarRef$, toolbarScope);
      const event = dispatchShortcut("c");

      expect(event.defaultPrevented).toBeTruthy();
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("Reply from thread A");
      });
      await vi.waitFor(() => {
        expect(ctx.store.get(feedbackSelectionValue$)).toBeNull();
      });
      expect(successToast).toHaveBeenCalledWith("Copied");
    } finally {
      cleanup?.();
      successToast.mockRestore();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("aborts toolbar shortcuts when the toolbar is closed", () => {
    const bubble = mountThreadBubble("thread-a", "Reply from thread A");
    selectContents(bubble);
    ctx.store.set(captureFeedbackSelection$);
    expect(ctx.store.get(feedbackSelectionValue$)).not.toBeNull();

    const toolbarScope = document.createElement("span");
    const cleanup = ctx.store.set(
      setFeedbackSelectionToolbarRef$,
      toolbarScope,
    );
    ctx.store.set(closeFeedbackSelectionToolbar$);

    const second = mountThreadBubble("thread-a", "Second passage");
    selectContents(second);
    ctx.store.set(captureFeedbackSelection$);
    const event = dispatchShortcut("f");

    expect(event.defaultPrevented).toBeFalsy();
    expect(ctx.store.get(feedbackItemsValue$)).toHaveLength(0);
    cleanup?.();
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
