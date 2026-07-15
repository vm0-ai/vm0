import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredPromise } from "../../signals/utils.ts";
import {
  setupVisualViewportKeyboardState,
  VISUAL_VIEWPORT_KEYBOARD_SETTLED_EVENT,
} from "../visual-viewport-keyboard.ts";

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

function setStandaloneDisplayMode(enabled: boolean): void {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const mediaQueryList = matchMedia(query);
    Object.defineProperty(mediaQueryList, "matches", {
      configurable: true,
      value: enabled && query === "(display-mode: standalone)",
    });
    return mediaQueryList;
  });
}

function focusTextEntry(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  textarea.focus();
  return textarea;
}

function focusComposerCaret(): {
  editor: HTMLDivElement;
  selection: Selection;
  text: Text;
} {
  const composer = document.createElement("div");
  composer.dataset.keyboardInsetTarget = "";
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  const text = document.createTextNode("Draft");
  editor.append(text);
  composer.append(editor);
  document.body.append(composer);

  const selection = document.getSelection();
  if (!selection) {
    throw new Error("Selection API unavailable");
  }
  const caretRange = document.createRange();
  caretRange.setStart(text, text.length);
  caretRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caretRange);
  editor.focus();

  onTestFinished(() => {
    document.getSelection()?.removeAllRanges();
  });

  return { editor, selection, text };
}

function installEmptyRangeRect(): void {
  const getRangeRectDescriptor = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect();
    },
  });
  onTestFinished(() => {
    if (getRangeRectDescriptor) {
      Object.defineProperty(
        Range.prototype,
        "getBoundingClientRect",
        getRangeRectDescriptor,
      );
      return;
    }
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });
}

function waitForAnimationFrames(frameCount = 1): Promise<void> {
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
  document.documentElement.style.removeProperty("--zero-keyboard-inset");
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
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("324px");

    viewport.resizeTo(844);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("");
  });

  it("tracks the keyboard inset until the closing animation finishes", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(520);
    await waitForAnimationFrames();
    viewport.resizeTo(760);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("84px");

    viewport.resizeTo(844);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("subtracts native viewport panning from the page keyboard inset", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(520);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("324px");

    viewport.resizeTo(520, 100);
    await waitForAnimationFrames();
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("224px");

    viewport.resizeTo(520, 324);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("0px");
  });

  it("keeps the focused composer's controls above native keyboard chrome", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    const composer = document.createElement("div");
    composer.dataset.keyboardInsetTarget = "";
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    editor.textContent = "Draft";
    composer.append(editor);
    document.body.append(composer);
    Object.defineProperty(composer, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 620, 400, 180);
      },
    });
    Object.defineProperty(editor, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 620, 400, 108);
      },
    });
    const getRangeRectDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect",
    );
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 630, 0, 20);
      },
    });
    onTestFinished(() => {
      document.getSelection()?.removeAllRanges();
      if (getRangeRectDescriptor) {
        Object.defineProperty(
          Range.prototype,
          "getBoundingClientRect",
          getRangeRectDescriptor,
        );
        return;
      }
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    });
    const selection = document.getSelection();
    if (!selection) {
      throw new Error("Selection API unavailable");
    }
    const caretRange = document.createRange();
    caretRange.selectNodeContents(editor);
    caretRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(caretRange);

    startViewportKeyboardState();
    editor.focus();
    viewport.resizeTo(520, 100);
    await waitForAnimationFrames();

    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("224px");

    viewport.resizeTo(520, 324);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("150px");

    viewport.resizeTo(520, 280);
    await waitForAnimationFrames();

    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("150px");

    viewport.resizeTo(800, 44);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("44px");

    viewport.resizeTo(844);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("");
  });

  it("uses the latest viewport metrics during continuous keyboard animation", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(680);
    await waitForAnimationFrames();
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("164px");

    viewport.resizeTo(600);
    await waitForAnimationFrames();
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("244px");

    viewport.resizeTo(520);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("324px");
  });

  it("dispatches a settled event only after the trailing viewport update", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);
    let settledEventCount = 0;
    const handleSettled = () => {
      settledEventCount += 1;
    };
    window.addEventListener(
      VISUAL_VIEWPORT_KEYBOARD_SETTLED_EVENT,
      handleSettled,
    );
    onTestFinished(() => {
      window.removeEventListener(
        VISUAL_VIEWPORT_KEYBOARD_SETTLED_EVENT,
        handleSettled,
      );
    });

    startViewportKeyboardState();
    focusTextEntry();
    viewport.resizeTo(520);

    await waitForAnimationFrames();
    expect(settledEventCount).toBe(0);

    await waitForAnimationFrames();
    expect(settledEventCount).toBe(1);
  });

  it("refreshes the standalone composer caret after each settled viewport change", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandaloneDisplayMode(true);
    installVisualViewport(viewport);
    installEmptyRangeRect();
    const { editor, selection, text } = focusComposerCaret();

    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
    const addRange = vi.spyOn(selection, "addRange");

    startViewportKeyboardState();
    viewport.resizeTo(520);

    await waitForAnimationFrames(2);
    expect(removeAllRanges).not.toHaveBeenCalled();
    expect(addRange).not.toHaveBeenCalled();

    await waitForAnimationFrames();
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(text.length);
    expect(editor.textContent).toBe("Draft");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("324px");

    viewport.dispatchEvent(new Event("scroll"));
    await waitForAnimationFrames(3);
    expect(removeAllRanges).toHaveBeenCalledTimes(2);
    expect(addRange).toHaveBeenCalledTimes(2);

    viewport.resizeTo(844);
    await waitForAnimationFrames(3);
    viewport.resizeTo(520);
    await waitForAnimationFrames(3);
    expect(removeAllRanges).toHaveBeenCalledTimes(3);
    expect(addRange).toHaveBeenCalledTimes(3);
  });

  it("does not refresh the composer caret outside standalone mode", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandaloneDisplayMode(false);
    installVisualViewport(viewport);
    installEmptyRangeRect();
    const { selection, text } = focusComposerCaret();

    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
    const addRange = vi.spyOn(selection, "addRange");

    startViewportKeyboardState();
    viewport.resizeTo(520);
    await waitForAnimationFrames(3);

    expect(removeAllRanges).not.toHaveBeenCalled();
    expect(addRange).not.toHaveBeenCalled();
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(text.length);
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("324px");
  });

  it("waits for composition to end before refreshing the composer caret", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandaloneDisplayMode(true);
    installVisualViewport(viewport);
    installEmptyRangeRect();
    const { editor, selection, text } = focusComposerCaret();
    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
    const addRange = vi.spyOn(selection, "addRange");

    startViewportKeyboardState();
    editor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    viewport.resizeTo(520);
    await waitForAnimationFrames(3);

    expect(removeAllRanges).not.toHaveBeenCalled();
    expect(addRange).not.toHaveBeenCalled();

    editor.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await waitForAnimationFrames();

    expect(removeAllRanges).toHaveBeenCalledTimes(1);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(text.length);
  });

  it("does not let an abandoned composition block the next composer", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandaloneDisplayMode(true);
    installVisualViewport(viewport);
    installEmptyRangeRect();
    const { editor } = focusComposerCaret();

    startViewportKeyboardState();
    editor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    viewport.resizeTo(520);
    await waitForAnimationFrames(3);

    editor.parentElement?.remove();
    const { selection, text } = focusComposerCaret();
    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
    const addRange = vi.spyOn(selection, "addRange");
    viewport.dispatchEvent(new Event("scroll"));
    await waitForAnimationFrames(3);

    expect(removeAllRanges).toHaveBeenCalledTimes(1);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(text.length);
  });

  it("preserves an expanded composer selection", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandaloneDisplayMode(true);
    installVisualViewport(viewport);
    installEmptyRangeRect();
    const { selection, text } = focusComposerCaret();
    const selectedRange = document.createRange();
    selectedRange.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(selectedRange);
    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
    const addRange = vi.spyOn(selection, "addRange");

    startViewportKeyboardState();
    viewport.resizeTo(520);
    await waitForAnimationFrames(3);

    expect(removeAllRanges).not.toHaveBeenCalled();
    expect(addRange).not.toHaveBeenCalled();
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(0);
    expect(selection.focusNode).toBe(text);
    expect(selection.focusOffset).toBe(text.length);
  });

  it("cancels a pending standalone caret refresh during cleanup", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandaloneDisplayMode(true);
    installVisualViewport(viewport);
    installEmptyRangeRect();
    const { selection } = focusComposerCaret();
    const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
    const addRange = vi.spyOn(selection, "addRange");

    const cleanup = startViewportKeyboardState();
    viewport.resizeTo(520);
    await waitForAnimationFrames(2);
    cleanup();
    await waitForAnimationFrames();

    expect(removeAllRanges).not.toHaveBeenCalled();
    expect(addRange).not.toHaveBeenCalled();
  });

  it("cancels the pending settled event during cleanup", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);
    let settledEventCount = 0;
    const handleSettled = () => {
      settledEventCount += 1;
    };
    window.addEventListener(
      VISUAL_VIEWPORT_KEYBOARD_SETTLED_EVENT,
      handleSettled,
    );
    onTestFinished(() => {
      window.removeEventListener(
        VISUAL_VIEWPORT_KEYBOARD_SETTLED_EVENT,
        handleSettled,
      );
    });

    const cleanup = startViewportKeyboardState();
    focusTextEntry();
    viewport.resizeTo(520);
    cleanup();

    await waitForAnimationFrames(2);
    expect(settledEventCount).toBe(0);
  });

  it("reads final viewport metrics after standalone layout settles", async () => {
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
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("0px");
  });

  it("updates the keyboard inset from visual viewport scroll events", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();

    viewport.resizeTo(520);
    await waitForAnimationFrames();
    viewport.offsetTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("224px");
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
    viewport.resizeTo(488);
    await waitForAnimationFrames();

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("356px");

    viewport.resizeTo(488, 356);
    await waitForAnimationFrames();
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("0px");
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
    await waitForAnimationFrames(2);

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("preserves a shifted standalone viewport baseline after orientation", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();
    viewport.resizeTo(520, 324);
    await waitForAnimationFrames();

    window.dispatchEvent(new Event("orientationchange"));
    window.requestAnimationFrame(() => {
      setInnerHeight(250);
      viewport.height = 250;
      viewport.offsetTop = 140;
    });
    await waitForAnimationFrames(2);

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(
      document.documentElement.style.getPropertyValue("--zero-keyboard-inset"),
    ).toBe("0px");
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
