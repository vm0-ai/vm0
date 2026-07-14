const KEYBOARD_SHRINK_RATIO = 0.15;
const MIN_KEYBOARD_SHRINK_PX = 120;
const KEYBOARD_VIEWPORT_HEIGHT_PROPERTY = "--zero-keyboard-viewport-height";
const KEYBOARD_VIEWPORT_OFFSET_TOP_PROPERTY =
  "--zero-keyboard-viewport-offset-top";

const TEXT_ENTRY_SELECTOR =
  "textarea, select, [contenteditable]:not([contenteditable='false'])";

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
  return Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    viewport.height + viewport.offsetTop,
  );
}

function viewportHasKeyboardOcclusion(
  baselineHeight: number,
  viewport: VisualViewport,
): boolean {
  const occludedHeight = baselineHeight - viewport.height * viewport.scale;
  const threshold = Math.max(
    MIN_KEYBOARD_SHRINK_PX,
    baselineHeight * KEYBOARD_SHRINK_RATIO,
  );

  return occludedHeight > threshold;
}

function setKeyboardOpen(viewport: VisualViewport): void {
  const root = document.documentElement;
  root.dataset.keyboardOpen = "true";
  root.style.setProperty(
    KEYBOARD_VIEWPORT_HEIGHT_PROPERTY,
    `${viewport.height}px`,
  );
  root.style.setProperty(
    KEYBOARD_VIEWPORT_OFFSET_TOP_PROPERTY,
    `${viewport.offsetTop}px`,
  );
}

function setKeyboardClosed(): void {
  const root = document.documentElement;
  delete root.dataset.keyboardOpen;
  root.style.removeProperty(KEYBOARD_VIEWPORT_HEIGHT_PROPERTY);
  root.style.removeProperty(KEYBOARD_VIEWPORT_OFFSET_TOP_PROPERTY);
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

  const update = () => {
    const activeTextEntry = isTextEntryElement(document.activeElement);

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

    keyboardOpen = viewportHasKeyboardOcclusion(baselineHeight, viewport);
    if (keyboardOpen) {
      setKeyboardOpen(viewport);
    } else {
      setKeyboardClosed();
    }
  };

  const scheduleUpdate = () => {
    if (scheduledFrameId !== null) {
      window.cancelAnimationFrame(scheduledFrameId);
    }
    scheduledFrameId = window.requestAnimationFrame(() => {
      scheduledFrameId = window.requestAnimationFrame(() => {
        scheduledFrameId = null;
        if (resetBaselineAfterLayout) {
          baselineHeight = readLayoutViewportHeight(viewport);
          resetBaselineAfterLayout = false;
        }
        update();
      });
    });
  };

  const scheduleBaselineReset = () => {
    resetBaselineAfterLayout = true;
    scheduleUpdate();
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
    setKeyboardClosed();
  };
}
