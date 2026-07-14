import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { createDeferredPromise } from "../../signals/utils.ts";
import { setupVisualViewportKeyboardState } from "../visual-viewport-keyboard.ts";

class MockVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  scale = 1;

  constructor(height: number) {
    super();
    this.height = height;
  }

  resizeTo(height: number, offsetTop = this.offsetTop): void {
    this.height = height;
    this.offsetTop = offsetTop;
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

function waitForAnimationFrames(frameCount = 2): Promise<void> {
  const viewportUpdated = createDeferredPromise<void>(AbortSignal.any([]));
  let remainingFrameCount = frameCount;
  const handleAnimationFrame = () => {
    remainingFrameCount -= 1;
    if (remainingFrameCount === 0) {
      viewportUpdated.resolve();
      return;
    }
    window.requestAnimationFrame(handleAnimationFrame);
  };
  window.requestAnimationFrame(handleAnimationFrame);
  return viewportUpdated.promise;
}

function startViewportKeyboardState(): () => void {
  const cleanup = setupVisualViewportKeyboardState();
  onTestFinished(cleanup);
  return cleanup;
}

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.keyboardOpen;
  document.documentElement.style.removeProperty(
    "--zero-keyboard-viewport-height",
  );
  document.documentElement.style.removeProperty(
    "--zero-keyboard-viewport-offset-top",
  );
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: undefined,
  });
});

describe("visual viewport keyboard state", () => {
  it("keeps the safe-area state when text entry is focused without viewport shrink", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();
    viewport.resizeTo(844);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("marks the keyboard open only while a focused text entry occludes the viewport", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(520);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-height",
      ),
    ).toBe("520px");
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-offset-top",
      ),
    ).toBe("0px");

    viewport.resizeTo(844);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-height",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-offset-top",
      ),
    ).toBe("");
  });

  it("marks the keyboard open when a standalone viewport also shifts down", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(520, 324);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-height",
      ),
    ).toBe("520px");
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-offset-top",
      ),
    ).toBe("324px");
  });

  it("reads viewport metrics after standalone layout settles", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(844);
    window.requestAnimationFrame(() => {
      viewport.resizeTo(844);
      window.requestAnimationFrame(() => {
        viewport.height = 520;
        viewport.offsetTop = 324;
      });
    });
    await waitForAnimationFrames(3);

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
  });

  it("does not treat visual viewport zoom as keyboard occlusion", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.scale = 2;
    viewport.resizeTo(422);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("detects keyboard occlusion while the focused viewport is zoomed", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.scale = 1.066;
    viewport.resizeTo(488, 356);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-height",
      ),
    ).toBe("488px");
    expect(
      document.documentElement.style.getPropertyValue(
        "--zero-keyboard-viewport-offset-top",
      ),
    ).toBe("356px");
  });

  it("resets the baseline after orientation metrics settle", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    window.dispatchEvent(new Event("orientationchange"));
    window.requestAnimationFrame(() => {
      setInnerHeight(390);
      viewport.height = 390;
    });
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("clears the keyboard state when focus leaves the text entry", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    const textarea = focusTextEntry();
    viewport.resizeTo(520);
    await waitForAnimationFrames();

    textarea.blur();
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("does not mark keyboard state without visualViewport support", () => {
    setInnerHeight(844);

    startViewportKeyboardState();
    focusTextEntry();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });
});
