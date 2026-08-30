import { describe, expect, it, vi, type Mock } from "vitest";
import { animationFrame, timeout } from "signal-timers";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise, resetSignal } from "../../signals/utils.ts";
import { setupVisualViewportKeyboardState } from "../visual-viewport-keyboard.ts";

const VIEWPORT_SETTLE_WAIT_MS = 75;
const context = testContext();
const resetViewportSettleSignal$ = resetSignal();

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
  vi.stubGlobal("visualViewport", viewport);
}

function setInnerHeight(height: number): void {
  vi.stubGlobal("innerHeight", height);
}

function setStandalone(matches: boolean): void {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches }));
}

function appendTextEntry(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  context.signal.addEventListener(
    "abort",
    () => {
      textarea.remove();
    },
    { once: true },
  );
  return textarea;
}

function focusTextEntry(): HTMLTextAreaElement {
  const textarea = appendTextEntry();
  textarea.focus();
  return textarea;
}

function focusComposer(inExistingThread: boolean): {
  editor: HTMLDivElement;
  scrollIntoView: Mock<HTMLElement["scrollIntoView"]>;
} {
  const container = document.createElement(
    inExistingThread ? "footer" : "section",
  );
  if (inExistingThread) {
    container.dataset.chatComposer = "";
  }

  const composer = document.createElement("div");
  composer.className = "zero-composer";
  const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  Object.defineProperty(composer, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });

  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  composer.append(editor);
  container.append(composer);
  document.body.append(container);
  context.signal.addEventListener(
    "abort",
    () => {
      container.remove();
    },
    { once: true },
  );
  editor.focus();

  return { editor, scrollIntoView };
}

function waitForViewportSettle(): Promise<void> {
  const settled = createDeferredPromise<void>(context.signal);
  timeout(
    () => {
      animationFrame(
        () => {
          settled.resolve();
        },
        { signal: context.signal },
      );
    },
    VIEWPORT_SETTLE_WAIT_MS,
    { signal: context.signal },
  );
  return settled.promise;
}

async function resizeAndSettle(
  viewport: MockVisualViewport,
  height: number,
  offsetTop = viewport.offsetTop,
): Promise<void> {
  viewport.resizeTo(height, offsetTop);
  await waitForViewportSettle();
}

function startViewportKeyboardState(): () => void {
  return setupVisualViewportKeyboardState(context.signal, () => {
    return context.store.set(resetViewportSettleSignal$, context.signal);
  });
}

describe("visual viewport keyboard state", () => {
  it("keeps the keyboard closed when focus does not shrink the viewport", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();
    await resizeAndSettle(viewport, 844);

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("waits for late standalone viewport metrics before opening", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();
    viewport.dispatchEvent(new Event("resize"));

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    // Standalone WebKit can update the final height without another event.
    viewport.height = 520;
    viewport.offsetTop = 100;
    await waitForViewportSettle();
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
  });

  it("reveals an existing thread composer once across each of five keyboard sessions", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandalone(true);
    installVisualViewport(viewport);
    const { editor, scrollIntoView } = focusComposer(true);

    startViewportKeyboardState();

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await resizeAndSettle(viewport, 520, 100 + cycle * 20);

      expect(scrollIntoView).toHaveBeenCalledTimes(cycle + 1);
      expect(
        document.documentElement.style.getPropertyValue(
          "--zero-keyboard-scroll-reserve",
        ),
      ).toBe("340px");
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        behavior: "auto",
        block: "end",
        inline: "nearest",
      });

      viewport.offsetTop = 280;
      viewport.dispatchEvent(new Event("scroll"));
      await waitForViewportSettle();
      expect(scrollIntoView).toHaveBeenCalledTimes(cycle + 1);

      if (cycle % 2 === 0) {
        // Hiding the software keyboard can leave its accessory bar visible
        // while the editor stays focused.
        await resizeAndSettle(viewport, 740, 100 + cycle * 20);
      } else {
        editor.blur();
        // WebKit can restore height fractionally before offsetTop clears.
        await resizeAndSettle(viewport, 843.4, 100 + cycle * 20);
      }
      expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
      expect(
        document.documentElement.style.getPropertyValue(
          "--zero-keyboard-scroll-reserve",
        ),
      ).toBe("");
      if (document.activeElement !== editor) {
        editor.focus();
      }
    }
  });

  it("does not add a second focus scroll on the agent homepage", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandalone(true);
    installVisualViewport(viewport);
    const { scrollIntoView } = focusComposer(false);

    startViewportKeyboardState();
    await resizeAndSettle(viewport, 520, 100);

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll the web app outside standalone mode", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    setStandalone(false);
    installVisualViewport(viewport);
    const { scrollIntoView } = focusComposer(true);

    startViewportKeyboardState();
    await resizeAndSettle(viewport, 520, 100);

    expect(document.documentElement.dataset.keyboardOpen).toBe("true");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the closed baseline stable across five mixed viewport cycles", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);
    focusTextEntry();
    startViewportKeyboardState();

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await resizeAndSettle(viewport, 520, 100 + cycle * 20);
      expect(document.documentElement.dataset.keyboardOpen).toBe("true");

      // Standalone WebKit can restore height before clearing offsetTop. This
      // mixed sample must not become the next cycle's layout baseline.
      await resizeAndSettle(viewport, 844, 100 + cycle * 20);
      expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
    }
  });

  it("keeps keyboard state while focus moves between text entries", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);
    const firstEntry = focusTextEntry();
    const secondEntry = appendTextEntry();

    startViewportKeyboardState();
    await resizeAndSettle(viewport, 520, 100);

    secondEntry.focus();
    await waitForViewportSettle();
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");

    secondEntry.blur();
    await waitForViewportSettle();
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
    expect(document.activeElement).not.toBe(firstEntry);
  });

  it("does not treat visual viewport zoom as keyboard occlusion", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);

    startViewportKeyboardState();
    focusTextEntry();
    viewport.scale = 2;
    await resizeAndSettle(viewport, 422);

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("resets the baseline after orientation metrics settle", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);
    const entry = focusTextEntry();
    startViewportKeyboardState();

    window.dispatchEvent(new Event("orientationchange"));
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    // The new orientation metrics arrive after orientationchange.
    setInnerHeight(390);
    viewport.height = 390;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    await waitForViewportSettle();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

    await resizeAndSettle(viewport, 250, 40);
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");

    entry.blur();
    await resizeAndSettle(viewport, 389.5, 40);
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("updates the closed baseline after an unfocused viewport resize", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);
    startViewportKeyboardState();

    setInnerHeight(700);
    await resizeAndSettle(viewport, 700, 0);

    focusTextEntry();
    await resizeAndSettle(viewport, 700, 0);
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("cancels a pending opening update during cleanup", async () => {
    const viewport = new MockVisualViewport(844);
    setInnerHeight(844);
    installVisualViewport(viewport);
    focusTextEntry();
    const cleanup = startViewportKeyboardState();

    viewport.resizeTo(520);
    cleanup();
    await waitForViewportSettle();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });

  it("does not mark keyboard state without VisualViewport support", () => {
    setInnerHeight(844);

    startViewportKeyboardState();
    focusTextEntry();

    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  });
});
