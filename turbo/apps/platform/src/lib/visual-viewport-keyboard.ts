const KEYBOARD_SHRINK_RATIO = 0.15;
const MIN_KEYBOARD_SHRINK_PX = 120;
const KEYBOARD_INSET_PROPERTY = "--zero-keyboard-inset";
const KEYBOARD_INSET_TARGET_SELECTOR = "[data-keyboard-inset-target]";
const CONTENTEDITABLE_SELECTOR =
  "[contenteditable]:not([contenteditable='false'])";
const STANDALONE_DISPLAY_MODE_QUERY = "(display-mode: standalone)";

export const VISUAL_VIEWPORT_KEYBOARD_SETTLED_EVENT =
  "vm0:visual-viewport-keyboard-settled";

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
  // offsetTop is only a fallback for recovering the full layout height. It is
  // intentionally never applied as an app-shell position in standalone mode.
  return Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    viewport.height * viewport.scale,
    viewport.height + viewport.offsetTop,
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

function readKeyboardLayoutInset(
  baselineHeight: number,
  viewport: VisualViewport,
): number {
  // WebKit may pan the visual viewport to keep the focused editor visible.
  // Only apply the part of the keyboard occlusion that native panning has not
  // already compensated for, otherwise bottom-anchored composers move twice.
  return Math.max(
    0,
    Math.round(baselineHeight - viewport.height - viewport.offsetTop),
  );
}

function readFocusedCaretBottom(activeElement: HTMLElement): number | null {
  if (!activeElement.matches(CONTENTEDITABLE_SELECTOR)) {
    return null;
  }

  const selection = activeElement.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const selectionRange = selection.getRangeAt(0);
  if (!activeElement.contains(selectionRange.commonAncestorContainer)) {
    return null;
  }

  const caretRange = selectionRange.cloneRange();
  caretRange.collapse(false);
  const caretRect = caretRange.getBoundingClientRect();
  return caretRect.top === 0 && caretRect.bottom === 0
    ? null
    : caretRect.bottom;
}

function refreshFocusedComposerCaret(): void {
  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLElement) ||
    !activeElement.matches(CONTENTEDITABLE_SELECTOR) ||
    activeElement.closest(KEYBOARD_INSET_TARGET_SELECTOR) === null
  ) {
    return;
  }

  const selection = activeElement.ownerDocument.getSelection();
  if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed) {
    return;
  }

  const selectionRange = selection.getRangeAt(0);
  if (!activeElement.contains(selectionRange.commonAncestorContainer)) {
    return;
  }

  // iOS WebKit can retain the caret rect from before its keyboard-driven
  // viewport pan. Reattaching the same collapsed range invalidates only the
  // native caret paint without moving the editor selection or page layout.
  const refreshedRange = selectionRange.cloneRange();
  selection.removeAllRanges();
  selection.addRange(refreshedRange);
}

type ComposerCaretRefresh = {
  cancel: () => void;
  endComposition: (event: CompositionEvent) => void;
  schedule: () => void;
  startComposition: (event: CompositionEvent) => void;
};

function createComposerCaretRefresh(
  keyboardIsOpen: () => boolean,
): ComposerCaretRefresh {
  let frameId: number | null = null;
  let compositionTarget: EventTarget | null = null;

  const cancel = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  const schedule = () => {
    cancel();
    if (
      !window.matchMedia(STANDALONE_DISPLAY_MODE_QUERY).matches ||
      !keyboardIsOpen() ||
      compositionTarget === document.activeElement
    ) {
      return;
    }

    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      if (!keyboardIsOpen() || compositionTarget === document.activeElement) {
        return;
      }

      refreshFocusedComposerCaret();
    });
  };

  return {
    cancel,
    endComposition: (event) => {
      if (event.target === compositionTarget) {
        compositionTarget = null;
      }
      schedule();
    },
    schedule,
    startComposition: (event) => {
      compositionTarget = event.target;
      cancel();
    },
  };
}

function readFocusedTargetTailInset(activeElement: HTMLElement): number {
  const target = activeElement.closest(KEYBOARD_INSET_TARGET_SELECTOR);
  if (!(target instanceof HTMLElement)) {
    return 0;
  }

  // Native focus panning only guarantees that the caret is visible; iOS can
  // still leave the controls below it behind the keyboard accessory bar. Use
  // a relative distance so both measurements stay in the same WebKit
  // coordinate space.
  const focusedBottom =
    readFocusedCaretBottom(activeElement) ??
    activeElement.getBoundingClientRect().bottom;
  return Math.max(
    0,
    Math.round(target.getBoundingClientRect().bottom - focusedBottom),
  );
}

function viewportHasKeyboardOcclusion(
  baselineHeight: number,
  viewport: VisualViewport,
  keyboardOpen: boolean,
): boolean {
  const occludedHeight = readKeyboardOcclusion(baselineHeight, viewport);
  if (keyboardOpen) {
    return occludedHeight > 0;
  }

  const threshold = Math.max(
    MIN_KEYBOARD_SHRINK_PX,
    baselineHeight * KEYBOARD_SHRINK_RATIO,
  );

  return occludedHeight > threshold;
}

function setKeyboardOpen(keyboardInset: number): void {
  const root = document.documentElement;
  root.dataset.keyboardOpen = "true";
  root.style.setProperty(KEYBOARD_INSET_PROPERTY, `${keyboardInset}px`);
}

function setKeyboardClosed(): void {
  const root = document.documentElement;
  delete root.dataset.keyboardOpen;
  root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
}

export function setupVisualViewportKeyboardState(): () => void {
  const viewport = window.visualViewport;

  if (!viewport) {
    return () => {
      setKeyboardClosed();
    };
  }

  let baselineHeight = readLayoutViewportHeight(viewport);
  let keyboardOpen = false;
  let resetBaselineAfterLayout = false;
  let scheduledFrameId: number | null = null;
  let settledFrameId: number | null = null;
  let orientationFrameId: number | null = null;
  const caretRefresh = createComposerCaretRefresh(() => {
    return keyboardOpen;
  });

  const update = () => {
    if (resetBaselineAfterLayout) {
      return;
    }

    const activeElement = document.activeElement;
    const activeTextEntry = isTextEntryElement(activeElement);

    if (!activeTextEntry) {
      keyboardOpen = false;
      caretRefresh.cancel();
      baselineHeight = readLayoutViewportHeight(viewport);
      setKeyboardClosed();
      return;
    }

    if (!keyboardOpen) {
      baselineHeight = Math.max(
        baselineHeight,
        readLayoutViewportHeight(viewport),
      );
    }

    keyboardOpen = viewportHasKeyboardOcclusion(
      baselineHeight,
      viewport,
      keyboardOpen,
    );
    if (keyboardOpen) {
      const focusedTargetTailInset =
        activeElement instanceof HTMLElement
          ? readFocusedTargetTailInset(activeElement)
          : 0;
      const keyboardInset = Math.max(
        readKeyboardLayoutInset(baselineHeight, viewport),
        Math.min(
          readKeyboardOcclusion(baselineHeight, viewport),
          focusedTargetTailInset,
        ),
      );
      setKeyboardOpen(keyboardInset);
    } else {
      caretRefresh.cancel();
      setKeyboardClosed();
    }
  };

  const scheduleUpdate = () => {
    caretRefresh.cancel();
    // Keep a live update pending during the native keyboard animation instead
    // of restarting the frame on every VisualViewport event.
    if (scheduledFrameId === null) {
      scheduledFrameId = window.requestAnimationFrame(() => {
        scheduledFrameId = null;
        update();
      });
    }

    // WebKit can publish its final metrics a frame after its last event. Keep a
    // separate trailing pass so the live updates are never delayed by settling.
    if (settledFrameId !== null) {
      window.cancelAnimationFrame(settledFrameId);
    }
    settledFrameId = window.requestAnimationFrame(() => {
      settledFrameId = window.requestAnimationFrame(() => {
        settledFrameId = null;
        update();
        window.dispatchEvent(new Event(VISUAL_VIEWPORT_KEYBOARD_SETTLED_EVENT));
        // Agent pages can synchronously scroll their composer in response to
        // the settled event. Refresh on the following frame so the native
        // caret is painted from the final editor coordinates.
        caretRefresh.schedule();
      });
    });
  };

  const scheduleBaselineReset = () => {
    resetBaselineAfterLayout = true;
    keyboardOpen = false;
    caretRefresh.cancel();
    setKeyboardClosed();
    if (orientationFrameId !== null) {
      window.cancelAnimationFrame(orientationFrameId);
    }
    orientationFrameId = window.requestAnimationFrame(() => {
      orientationFrameId = window.requestAnimationFrame(() => {
        orientationFrameId = null;
        baselineHeight = readLayoutViewportHeight(viewport);
        resetBaselineAfterLayout = false;
        update();
      });
    });
  };

  viewport.addEventListener("resize", scheduleUpdate);
  viewport.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("orientationchange", scheduleBaselineReset);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", update);
  document.addEventListener("compositionstart", caretRefresh.startComposition);
  document.addEventListener("compositionend", caretRefresh.endComposition);
  update();

  return () => {
    viewport.removeEventListener("resize", scheduleUpdate);
    viewport.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("orientationchange", scheduleBaselineReset);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", update);
    document.removeEventListener(
      "compositionstart",
      caretRefresh.startComposition,
    );
    document.removeEventListener("compositionend", caretRefresh.endComposition);
    if (scheduledFrameId !== null) {
      window.cancelAnimationFrame(scheduledFrameId);
    }
    if (settledFrameId !== null) {
      window.cancelAnimationFrame(settledFrameId);
    }
    if (orientationFrameId !== null) {
      window.cancelAnimationFrame(orientationFrameId);
    }
    caretRefresh.cancel();
    setKeyboardClosed();
  };
}
