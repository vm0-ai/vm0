const KEYBOARD_SHRINK_RATIO = 0.15;
const MIN_KEYBOARD_SHRINK_PX = 120;
const KEYBOARD_INSET_PROPERTY = "--zero-keyboard-inset";
const KEYBOARD_INSET_TARGET_SELECTOR = "[data-keyboard-inset-target]";
const CONTENTEDITABLE_SELECTOR =
  "[contenteditable]:not([contenteditable='false'])";

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

  const update = () => {
    if (resetBaselineAfterLayout) {
      return;
    }

    const activeElement = document.activeElement;
    const activeTextEntry = isTextEntryElement(activeElement);

    if (!activeTextEntry) {
      keyboardOpen = false;
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
      setKeyboardClosed();
    }
  };

  const scheduleUpdate = () => {
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
      });
    });
  };

  const scheduleBaselineReset = () => {
    resetBaselineAfterLayout = true;
    keyboardOpen = false;
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
  update();

  return () => {
    viewport.removeEventListener("resize", scheduleUpdate);
    viewport.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("orientationchange", scheduleBaselineReset);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", update);
    if (scheduledFrameId !== null) {
      window.cancelAnimationFrame(scheduledFrameId);
    }
    if (settledFrameId !== null) {
      window.cancelAnimationFrame(settledFrameId);
    }
    if (orientationFrameId !== null) {
      window.cancelAnimationFrame(orientationFrameId);
    }
    setKeyboardClosed();
  };
}
