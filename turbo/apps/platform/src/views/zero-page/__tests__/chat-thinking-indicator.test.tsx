import { waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const THREAD_ID = "thread-thinking-indicator-chunks";
const RUN_ID = "run-thinking-indicator-chunks";

/**
 * Two clauses that cannot share a line under the stubbed metrics below: 3 and
 * 4 glyphs fit on their own (390px and 520px) but merging them would need
 * 910px against a 552px budget, so the label must show exactly two chunks.
 *
 * The clause boundary deliberately disagrees with a pure width break: 4 glyphs
 * fit per line, so splitting on width alone would put "建好，在" on the first
 * line and leave "统计。" starting mid-phrase on the second. Only clause-aware
 * chunking produces the two chunks asserted below.
 */
const CLAUSE_1 = "建好，";
const CLAUSE_2 = "在统计。";
const THINKING_TEXT = `${CLAUSE_1}${CLAUSE_2}`;
const FIRST_CHUNK = CLAUSE_1;
const LAST_CHUNK = CLAUSE_2;

const LABEL_WIDTH_PX = 560;
const CJK_GLYPH_PX = 130;
const LATIN_GLYPH_PX = 65;
/** First code point of the CJK radical/ideograph range (U+2E80). */
const CJK_RANGE_START = 11_904;
const NBSP = "\u00a0";

/**
 * happy-dom reports `clientWidth === 0` and returns `null` from
 * `getContext("2d")`, so the label would fall back to glyph-count splitting and
 * never exercise clause packing. Stub both DOM capabilities — canvas text
 * metrics and the label's measured width — so the real production code path
 * runs against deterministic metrics.
 */
function stubLabelTextMeasurement(): void {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const measuringContext = {
    font: "",
    measureText(value: string) {
      const width = Array.from(value).reduce((total, glyph) => {
        return (
          total +
          (glyph.codePointAt(0)! > CJK_RANGE_START
            ? CJK_GLYPH_PX
            : LATIN_GLYPH_PX)
        );
      }, 0);
      return { width };
    },
  };
  HTMLCanvasElement.prototype.getContext = function stubbedGetContext(
    this: HTMLCanvasElement,
    contextId: string,
    ...rest: unknown[]
  ) {
    if (contextId === "2d") {
      return measuringContext;
    }
    return (
      originalGetContext as unknown as (
        this: HTMLCanvasElement,
        id: string,
        ...args: unknown[]
      ) => unknown
    ).call(this, contextId, ...rest);
  } as typeof HTMLCanvasElement.prototype.getContext;

  const originalRect = HTMLParagraphElement.prototype.getBoundingClientRect;
  HTMLParagraphElement.prototype.getBoundingClientRect = function stubbedRect(
    this: HTMLParagraphElement,
  ) {
    if (this.classList.contains("zero-shimmer-text")) {
      return new DOMRect(0, 0, LABEL_WIDTH_PX, 20);
    }
    return originalRect.call(this);
  };

  onTestFinished(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLParagraphElement.prototype.getBoundingClientRect = originalRect;
  });
}

function serverThinkingLabelText(): string {
  const label = document.querySelector<HTMLElement>(
    "[data-thinking-indicator] p.zero-shimmer-text",
  );
  // Only the server-driven label carries the full text as its accessible name;
  // the rotating placeholder phrase does not.
  if (label?.getAttribute("aria-label") !== THINKING_TEXT) {
    return "";
  }
  const text = label.textContent ?? "";
  // The label renders a non-breaking space to hold its height before the first
  // chunk has any characters; that is an empty line, not rendered status text.
  return text === NBSP ? "" : text;
}

/** Record every distinct value the live label renders while the run streams. */
function recordRenderedLabelText(): string[] {
  const rendered: string[] = [];
  const observer = new MutationObserver(() => {
    const text = serverThinkingLabelText();
    if (text && rendered[rendered.length - 1] !== text) {
      rendered.push(text);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  onTestFinished(() => {
    observer.disconnect();
  });
  return rendered;
}

function setupThinkingRun(): string[] {
  stubLabelTextMeasurement();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [RUN_ID],
    chatEvents: [
      {
        id: "msg-thinking-chunks-user",
        role: "user",
        content: "统计一下这些文件",
        runId: RUN_ID,
        createdAt: "2026-08-05T10:00:00Z",
      },
      {
        id: "msg-thinking-chunks-start",
        role: "assistant",
        content: null,
        runId: RUN_ID,
        createdAt: "2026-08-05T10:00:01Z",
      },
      {
        id: "msg-thinking-chunks-thinking",
        role: "assistant",
        content: null,
        thinking: THINKING_TEXT,
        runId: RUN_ID,
        createdAt: "2026-08-05T10:00:02Z",
      },
    ],
  });

  const rendered = recordRenderedLabelText();

  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  return rendered;
}

function expectedChunks(): readonly string[] {
  return [FIRST_CHUNK, LAST_CHUNK];
}

/**
 * Walk the run one chunk at a time. Each wait covers at most a couple of
 * typewriter ticks, so no single step depends on the whole animation fitting
 * inside one timeout. The waits assert against the recorded frames rather than
 * a live DOM read, because a completed chunk only stays on screen for one tick
 * before it fades out.
 */
async function waitForBothChunks(rendered: readonly string[]): Promise<void> {
  await waitFor(() => {
    expect(rendered.length).toBeGreaterThan(0);
  });
  await waitFor(() => {
    expect(rendered).toContain(FIRST_CHUNK);
  });
  await waitFor(() => {
    expect(rendered).toContain(LAST_CHUNK);
  });
}

describe("chat thinking indicator", () => {
  it("advances the live status text one clause-bounded chunk at a time", async () => {
    const rendered = setupThinkingRun();
    await waitForBothChunks(rendered);

    const chunkOfFrame = rendered.map((frame) => {
      return expectedChunks().findIndex((chunk) => {
        return chunk.startsWith(frame);
      });
    });

    // Both chunks were displayed, so the line really did advance rather than
    // stopping on the first one.
    expect(chunkOfFrame).toContain(0);
    expect(chunkOfFrame).toContain(1);

    // The second chunk replaces the first outright: the first frame of chunk
    // two does not continue the text that was on screen just before it.
    const swapAt = chunkOfFrame.indexOf(1);
    const beforeSwap = rendered[swapAt - 1]!;
    const afterSwap = rendered[swapAt]!;
    expect(afterSwap.startsWith(beforeSwap)).toBeFalsy();

    // The settled line is a whole clause, not a phrase cut in half.
    expect(serverThinkingLabelText().endsWith("。")).toBeTruthy();
  });

  it("never renders a horizontally scrolled window of the status text", async () => {
    const rendered = setupThinkingRun();
    await waitForBothChunks(rendered);

    expect(rendered.length).toBeGreaterThan(0);

    // A sliding window renders a tail of the text behind an ellipsis prefix
    // and starts mid-phrase. Every frame must instead be a growing prefix of
    // one of the two chunks, which is what proves the line never scrolls
    // sideways and never starts mid-clause.
    for (const frame of rendered) {
      expect(frame.startsWith("...")).toBeFalsy();
      expect(
        expectedChunks().some((chunk) => {
          return chunk.startsWith(frame);
        }),
      ).toBeTruthy();
    }
  });
});
