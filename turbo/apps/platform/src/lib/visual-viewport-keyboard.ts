import { delay } from "signal-timers";
import { detach, Reason } from "../signals/utils.ts";
import { captureVisualViewportResidue } from "./posthog.ts";

const KEYBOARD_SHRINK_RATIO = 0.15;
const MIN_KEYBOARD_SHRINK_PX = 120;
const LAYOUT_VIEWPORT_CHANGE_TOLERANCE_PX = 8;
const VIEWPORT_SETTLE_DELAY_MS = 50;
const VISUAL_VIEWPORT_RESIDUE_TOLERANCE_PX = 1;
const CONTENTEDITABLE_SELECTOR =
  "[contenteditable]:not([contenteditable='false'])";
const CHAT_COMPOSER_SELECTOR = "[data-chat-composer] .okou-composer";
const KEYBOARD_SCROLL_RESERVE_PROPERTY = "--okou-keyboard-scroll-reserve";
const VISUAL_VIEWPORT_TOP_PROPERTY = "--okou-visual-viewport-top";
const VISUAL_VIEWPORT_HEIGHT_PROPERTY = "--okou-visual-viewport-height";
const COMPOSER_KEYBOARD_GAP_PX = 16;
const STANDALONE_DISPLAY_MODE_QUERY = "(display-mode: standalone)";
const COARSE_POINTER_QUERY = "(pointer: coarse)";
const FINE_POINTER_QUERY = "(any-pointer: fine)";

const TEXT_ENTRY_SELECTOR = `textarea, select, ${CONTENTEDITABLE_SELECTOR}`;

function isNonTextInputType(type: string): boolean {
  switch (type) {
    case "button":
    case "checkbox":
    case "color":
    case "file":
    case "hidden":
    case "image":
    case "radio":
    case "range":
    case "reset":
    case "submit": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isTextEntryElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element instanceof HTMLInputElement) {
    return !isNonTextInputType(element.type);
  }

  return element.matches(TEXT_ENTRY_SELECTOR);
}

function readLayoutViewportHeight(viewport: VisualViewport): number {
  // offsetTop can briefly outlive the keyboard during standalone PWA close.
  // Never add it to the baseline or each open/close cycle can make the
  // keyboard appear taller than the previous one.
  return Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    viewport.height * viewport.scale,
  );
}

function readKeyboardOcclusion(
  baselineHeight: number,
  viewport: VisualViewport,
): number {
  return Math.max(
    0,
    Math.round(baselineHeight - viewport.height * viewport.scale),
  );
}

function viewportHasKeyboardOcclusion(
  baselineHeight: number,
  viewport: VisualViewport,
): boolean {
  const occludedHeight = readKeyboardOcclusion(baselineHeight, viewport);
  const keyboardThreshold = Math.max(
    MIN_KEYBOARD_SHRINK_PX,
    baselineHeight * KEYBOARD_SHRINK_RATIO,
  );

  // Hiding the software keyboard can leave the focused input accessory bar
  // visible. Occlusion too small to open a keyboard session must also close
  // the previous session, otherwise the next software-keyboard reveal is
  // mistaken for the same session.
  return occludedHeight > keyboardThreshold;
}

/**
 * Reports whether a software keyboard currently occludes the visual viewport.
 *
 * WebKit reports `any-pointer: fine` and `any-hover: hover` on iPhones, so
 * pointer media queries cannot tell a trackpad-and-keyboard tablet apart from
 * a phone. A shrunk visual viewport over an unchanged layout viewport is the
 * device's own evidence that the on-screen keyboard produced the keystroke.
 */
function softwareKeyboardOccludesViewport(): boolean {
  const viewport = window.visualViewport;
  if (!viewport) {
    return false;
  }
  return viewportHasKeyboardOcclusion(
    readLayoutViewportHeight(viewport),
    viewport,
  );
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * Reports whether text entry should use mobile-safe interaction behavior.
 *
 * A fine pointer normally means a hardware keyboard is available, while the
 * visual viewport detects an active software keyboard. WebKit reports a fine
 * pointer on iOS even without one, so iOS also needs an explicit fallback.
 */
export function isMobileTextInputDevice(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.matchMedia(COARSE_POINTER_QUERY).matches &&
    (!window.matchMedia(FINE_POINTER_QUERY).matches ||
      isIOSDevice() ||
      softwareKeyboardOccludesViewport())
  );
}

function setKeyboardOpen(keyboardOcclusion: number): void {
  const root = document.documentElement;
  root.dataset.keyboardOpen = "true";
  root.style.setProperty(
    KEYBOARD_SCROLL_RESERVE_PROPERTY,
    `${keyboardOcclusion + COMPOSER_KEYBOARD_GAP_PX}px`,
  );
}

function setKeyboardClosed(): void {
  const root = document.documentElement;
  delete root.dataset.keyboardOpen;
  root.style.removeProperty(KEYBOARD_SCROLL_RESERVE_PROPERTY);
}

function readVisualViewportOffsetTop(viewport: VisualViewport): number {
  return Math.round(viewport.offsetTop);
}

function hasVisualViewportResidue(viewport: VisualViewport): boolean {
  return (
    readVisualViewportOffsetTop(viewport) > VISUAL_VIEWPORT_RESIDUE_TOLERANCE_PX
  );
}

// iOS browser surfaces can keep the visual viewport panned after the keyboard
// closes, which leaves a fixed app root partly above the screen and a blank
// band below it. While that residue is observed, the root follows the visual
// viewport instead of the layout viewport.
function setVisualViewportResidue(viewport: VisualViewport): void {
  const root = document.documentElement;
  root.dataset.visualViewportResidue = "true";
  root.style.setProperty(
    VISUAL_VIEWPORT_TOP_PROPERTY,
    `${readVisualViewportOffsetTop(viewport)}px`,
  );
  root.style.setProperty(
    VISUAL_VIEWPORT_HEIGHT_PROPERTY,
    `${Math.round(viewport.height)}px`,
  );
}

function clearVisualViewportResidue(): void {
  const root = document.documentElement;
  delete root.dataset.visualViewportResidue;
  root.style.removeProperty(VISUAL_VIEWPORT_TOP_PROPERTY);
  root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_PROPERTY);
}

type FrameTask = {
  /** Run once on the next animation frame; a pending frame is reused. */
  schedule(): void;
  cancel(): void;
};

function createFrameTask(run: () => void): FrameTask {
  let frameId: number | null = null;
  return {
    schedule() {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        run();
      });
    },
    cancel() {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
    },
  };
}

type SettledCommit = {
  /** Commit once the viewport has been quiet for the settle delay. */
  schedule(): void;
  cancel(): void;
};

function createSettledCommit(
  resetSettledSignal: () => AbortSignal,
  commit: () => void,
): SettledCommit {
  let timerSignal: AbortSignal | null = null;

  const cancel = () => {
    if (timerSignal) {
      resetSettledSignal();
      timerSignal = null;
    }
  };

  const run = async (settledSignal: AbortSignal) => {
    await delay(VIEWPORT_SETTLE_DELAY_MS, { signal: settledSignal });
    settledSignal.throwIfAborted();
    if (timerSignal !== settledSignal) {
      return;
    }
    timerSignal = null;
    commit();
  };

  return {
    cancel,
    schedule() {
      cancel();
      const settledSignal = resetSettledSignal();
      timerSignal = settledSignal;
      detach(run(settledSignal), Reason.DomCallback, "visual viewport settle");
    },
  };
}

type VisualViewportResidueTracker = {
  /** The keyboard session ended; the next settled sample decides. */
  markClosed(): void;
  /** A settled sample arrived while the keyboard is closed. */
  commit(): void;
  /** A live sample arrived while the keyboard is closed. */
  sync(): void;
  /** Stop tracking, for example because the keyboard reopened. */
  clear(): void;
};

function createVisualViewportResidueTracker(
  viewport: VisualViewport,
  isKeyboardOpen: () => boolean,
): VisualViewportResidueTracker {
  let checkPending = false;
  let following = false;
  let offsetTopBeforeScroll = 0;

  const sync = () => {
    if (!following) {
      return;
    }
    if (hasVisualViewportResidue(viewport)) {
      setVisualViewportResidue(viewport);
      return;
    }
    following = false;
    clearVisualViewportResidue();
  };

  // WebKit publishes the offsetTop that results from the origin scroll on the
  // next frame; follow the visual viewport only when the pan survived it.
  const decideFrame = createFrameTask(() => {
    if (isKeyboardOpen()) {
      return;
    }
    const recoveredByScroll = !hasVisualViewportResidue(viewport);
    if (!recoveredByScroll) {
      following = true;
      setVisualViewportResidue(viewport);
    }
    captureVisualViewportResidue({
      innerHeight: window.innerHeight,
      offsetTopAfterScroll: readVisualViewportOffsetTop(viewport),
      offsetTopBeforeScroll,
      recoveredByScroll,
      viewportHeight: Math.round(viewport.height),
    });
  });

  const check = () => {
    if (window.matchMedia(STANDALONE_DISPLAY_MODE_QUERY).matches) {
      // Standalone WebKit briefly reports a stale offsetTop after close, and
      // its root is scrolled programmatically through the keyboard reserve.
      return;
    }
    decideFrame.cancel();
    if (!hasVisualViewportResidue(viewport)) {
      return;
    }
    offsetTopBeforeScroll = readVisualViewportOffsetTop(viewport);
    // A stuck document scroll is the cheap case: return to the origin first.
    window.scrollTo(0, 0);
    decideFrame.schedule();
  };

  return {
    markClosed() {
      checkPending = true;
    },
    commit() {
      if (checkPending) {
        checkPending = false;
        check();
        return;
      }
      sync();
    },
    sync,
    clear() {
      decideFrame.cancel();
      checkPending = false;
      following = false;
      clearVisualViewportResidue();
    },
  };
}

function revealFocusedComposer(): void {
  if (!window.matchMedia(STANDALONE_DISPLAY_MODE_QUERY).matches) {
    return;
  }

  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return;
  }

  const target = activeElement.closest(CHAT_COMPOSER_SELECTOR);
  if (!(target instanceof HTMLElement)) {
    return;
  }

  // Keep the editor's document geometry stable and reveal the whole composer
  // through a real scroll. WebKit synchronizes its native caret layer on the
  // scrolling path, unlike CSS reflow of a focused fixed-position descendant.
  target.scrollIntoView({
    behavior: "auto",
    block: "end",
    inline: "nearest",
  });
}

type KeyboardViewportState = {
  baselineHeight: number;
  keyboardOpen: boolean;
  resetBaselineOnSettle: boolean;
};

function updateKeyboardViewportState(
  state: KeyboardViewportState,
  viewport: VisualViewport,
  commitOpening: boolean,
): void {
  if (state.resetBaselineOnSettle) {
    if (!commitOpening) {
      return;
    }
    state.baselineHeight = readLayoutViewportHeight(viewport);
    state.keyboardOpen = false;
    state.resetBaselineOnSettle = false;
  }

  if (!isTextEntryElement(document.activeElement)) {
    if (commitOpening) {
      // A trailing unfocused sample is a stable layout viewport, including
      // window and stage resizes that are unrelated to the keyboard.
      state.baselineHeight = readLayoutViewportHeight(viewport);
    }
    state.keyboardOpen = false;
    setKeyboardClosed();
    return;
  }

  const hasKeyboardOcclusion = viewportHasKeyboardOcclusion(
    state.baselineHeight,
    viewport,
  );
  if (!hasKeyboardOcclusion) {
    state.keyboardOpen = false;
    setKeyboardClosed();
    return;
  }

  if (!state.keyboardOpen && !commitOpening) {
    return;
  }

  state.keyboardOpen = true;
  setKeyboardOpen(readKeyboardOcclusion(state.baselineHeight, viewport));
}

export function setupVisualViewportKeyboardState(
  signal: AbortSignal,
  resetSettledSignal: () => AbortSignal,
): () => void {
  signal.throwIfAborted();
  const viewport = window.visualViewport;

  if (!viewport) {
    return () => {
      setKeyboardClosed();
    };
  }

  const state: KeyboardViewportState = {
    baselineHeight: readLayoutViewportHeight(viewport),
    keyboardOpen: false,
    resetBaselineOnSettle: false,
  };
  const residue = createVisualViewportResidueTracker(viewport, () => {
    return state.keyboardOpen;
  });
  // The scroll reserve is a pseudo-element driven by the keyboard-open style.
  // Give WebKit one layout frame to publish the new scrollHeight before asking
  // it to reveal the composer.
  const revealFrame = createFrameTask(() => {
    if (state.keyboardOpen) {
      revealFocusedComposer();
    }
  });

  const update = (commitOpening: boolean) => {
    const keyboardWasOpen = state.keyboardOpen;
    updateKeyboardViewportState(state, viewport, commitOpening);
    if (!state.keyboardOpen) {
      if (keyboardWasOpen) {
        residue.markClosed();
      }
      // The residue check waits for the settled close sample; until then a
      // running follow keeps tracking the visual viewport.
      if (commitOpening) {
        residue.commit();
      } else {
        residue.sync();
      }
      revealFrame.cancel();
      return;
    }
    if (!keyboardWasOpen) {
      residue.clear();
      revealFrame.cancel();
      revealFrame.schedule();
    }
  };

  // Keep committed keyboard geometry live during animation and caret-driven
  // viewport panning.
  const updateFrame = createFrameTask(() => {
    update(false);
  });
  // Standalone WebKit can publish its final offsetTop without another event.
  // The short trailing read also prevents the first stale resize sample from
  // moving the page before the native focus pan has settled.
  const settledCommit = createSettledCommit(resetSettledSignal, () => {
    update(true);
  });

  const scheduleUpdate = () => {
    updateFrame.schedule();
    settledCommit.schedule();
  };

  const scheduleBaselineReset = () => {
    state.resetBaselineOnSettle = true;
    state.keyboardOpen = false;
    settledCommit.cancel();
    setKeyboardClosed();
    residue.clear();

    // Some WebKit versions emit orientationchange before the new viewport
    // metrics and others emit it afterwards. Commit immediately only for the
    // latter; otherwise the following VisualViewport resize starts settling.
    if (
      Math.abs(readLayoutViewportHeight(viewport) - state.baselineHeight) >
      LAYOUT_VIEWPORT_CHANGE_TOLERANCE_PX
    ) {
      scheduleUpdate();
    }
  };

  viewport.addEventListener("resize", scheduleUpdate);
  viewport.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("orientationchange", scheduleBaselineReset);
  document.addEventListener("focusin", scheduleUpdate);
  document.addEventListener("focusout", scheduleUpdate);
  update(false);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    signal.removeEventListener("abort", cleanup);
    viewport.removeEventListener("resize", scheduleUpdate);
    viewport.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("orientationchange", scheduleBaselineReset);
    document.removeEventListener("focusin", scheduleUpdate);
    document.removeEventListener("focusout", scheduleUpdate);
    updateFrame.cancel();
    revealFrame.cancel();
    settledCommit.cancel();
    setKeyboardClosed();
    residue.clear();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
