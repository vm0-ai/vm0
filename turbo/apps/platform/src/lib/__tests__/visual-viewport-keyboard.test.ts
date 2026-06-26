import { afterEach, describe, expect, it } from "vitest";
import { setupVisualViewportKeyboardState } from "../visual-viewport-keyboard.ts";

class MockVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;

  constructor(height: number) {
    super();
    this.height = height;
  }

  resizeTo(height: number): void {
    this.height = height;
    this.dispatchEvent(new Event("resize"));
  }
}

function installVisualViewport(viewport: MockVisualViewport): void {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
}

function setInnerHeight(height: number): void {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

function focusTextEntry(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  textarea.focus();
  return textarea;
}

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.keyboardOpen;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: undefined,
  });
});

describe("visual viewport keyboard state", () => {
  it("keeps the safe-area state when text entry is focused without viewport shrink", () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    const cleanup = setupVisualViewportKeyboardState();
    focusTextEntry();
    viewport.resizeTo(844);

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    cleanup();
  });

  it("marks the keyboard open only while a focused text entry occludes the viewport", () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    const cleanup = setupVisualViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(520);
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");

    viewport.resizeTo(844);
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    cleanup();
  });

  it("clears the keyboard state when focus leaves the text entry", () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    const cleanup = setupVisualViewportKeyboardState();
    const textarea = focusTextEntry();
    viewport.resizeTo(520);

    textarea.blur();
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    cleanup();
  });

  it("does not mark keyboard state without visualViewport support", () => {
    setInnerHeight(844);

    const cleanup = setupVisualViewportKeyboardState();
    focusTextEntry();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    cleanup();
  });
});
