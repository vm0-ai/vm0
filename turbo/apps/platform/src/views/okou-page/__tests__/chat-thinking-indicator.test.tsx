import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000210";
const RUN_ID = "run-thinking-indicator-lines";

const FIRST_LINE = "整理这些文件，隐藏后缀不会出现。";
const SECOND_LINE = "生成结果。";
const THINKING_TEXT = `${FIRST_LINE}\n${SECOND_LINE}`;

const LABEL_WIDTH_PX = 560;
const CJK_GLYPH_PX = 100;
const LATIN_GLYPH_PX = 50;
/** First code point of the CJK radical/ideograph range (U+2E80). */
const CJK_RANGE_START = 11_904;
const FIRST_OVERFLOW_FRAME = "整理这些文…";
const NBSP = "\u00a0";

/**
 * happy-dom does not provide canvas text metrics or useful layout widths.
 * Stub those browser boundaries so the first line overflows after its sixth
 * glyph while the explicit second line still fits in full.
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function stubbedGetContext(
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
    } as typeof HTMLCanvasElement.prototype.getContext,
  );

  const originalRect = HTMLParagraphElement.prototype.getBoundingClientRect;
  vi.spyOn(
    HTMLParagraphElement.prototype,
    "getBoundingClientRect",
  ).mockImplementation(function stubbedRect(this: HTMLParagraphElement) {
    if (this.classList.contains("zero-shimmer-text")) {
      return new DOMRect(0, 0, LABEL_WIDTH_PX, 20);
    }
    return originalRect.call(this);
  });
}

function serverThinkingLabelText(): string {
  const label = document.querySelector<HTMLElement>(
    "[data-thinking-indicator] p.zero-shimmer-text",
  );
  if (label?.getAttribute("aria-label") !== THINKING_TEXT) {
    return "";
  }
  const text = label.textContent ?? "";
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
  context.signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
  return rendered;
}

function setupThinkingRun(): string[] {
  stubLabelTextMeasurement();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [RUN_ID],
    chatEvents: [
      {
        id: "msg-thinking-lines-user",
        role: "user",
        content: "统计一下这些文件",
        runId: RUN_ID,
        createdAt: "2026-08-05T10:00:00Z",
      },
      {
        id: "msg-thinking-lines-start",
        role: "assistant",
        content: null,
        runId: RUN_ID,
        createdAt: "2026-08-05T10:00:01Z",
      },
      {
        id: "msg-thinking-lines-thinking",
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

async function waitForBothLines(rendered: readonly string[]): Promise<void> {
  await waitFor(() => {
    expect(rendered).toContain(FIRST_OVERFLOW_FRAME);
  });
  await waitFor(() => {
    expect(rendered).toContain(SECOND_LINE);
  });
}

describe("chat thinking indicator", () => {
  it("discards an overflowing line remainder before showing the next explicit line", async () => {
    const rendered = setupThinkingRun();
    await waitForBothLines(rendered);

    expect(rendered).toContain(FIRST_OVERFLOW_FRAME);
    expect(rendered).toContain(SECOND_LINE);
    expect(
      rendered.some((frame) => {
        return frame.includes("隐藏后缀");
      }),
    ).toBeFalsy();

    const secondLineStart = rendered.findIndex((frame) => {
      return SECOND_LINE.startsWith(frame);
    });
    expect(secondLineStart).toBeGreaterThan(0);
    expect(rendered[secondLineStart - 1]).toBe(FIRST_OVERFLOW_FRAME);
  });

  it("never turns an overflowing remainder into another displayed line", async () => {
    const rendered = setupThinkingRun();
    await waitForBothLines(rendered);

    for (const frame of rendered) {
      expect(
        FIRST_LINE.startsWith(frame.replace(/…$/, "")) ||
          SECOND_LINE.startsWith(frame),
      ).toBeTruthy();
    }
    expect(serverThinkingLabelText()).toBe(SECOND_LINE);
  });
});
