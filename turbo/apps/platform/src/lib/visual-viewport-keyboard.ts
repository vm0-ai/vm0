const KEYBOARD_SHRINK_RATIO = 0.15;
const MIN_KEYBOARD_SHRINK_PX = 120;

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
  const visibleBottom = viewport.height + viewport.offsetTop;
  const occludedHeight = baselineHeight - visibleBottom;
  const threshold = Math.max(
    MIN_KEYBOARD_SHRINK_PX,
    baselineHeight * KEYBOARD_SHRINK_RATIO,
  );

  return occludedHeight > threshold;
}

function setKeyboardOpen(open: boolean): void {
  if (open) {
    document.documentElement.dataset.keyboardOpen = "true";
  } else {
    delete document.documentElement.dataset.keyboardOpen;
  }
}

export function setupVisualViewportKeyboardState(): () => void {
  const viewport = window.visualViewport;

  if (!viewport) {
    return () => {
      setKeyboardOpen(false);
    };
  }

  let baselineHeight = readLayoutViewportHeight(viewport);
  let keyboardOpen = false;

  const update = () => {
    const activeTextEntry = isTextEntryElement(document.activeElement);

    if (!activeTextEntry) {
      keyboardOpen = false;
      baselineHeight = readLayoutViewportHeight(viewport);
      setKeyboardOpen(false);
      return;
    }

    if (!keyboardOpen) {
      baselineHeight = Math.max(
        baselineHeight,
        readLayoutViewportHeight(viewport),
      );
    }

    keyboardOpen = viewportHasKeyboardOcclusion(baselineHeight, viewport);
    setKeyboardOpen(keyboardOpen);
  };

  const resetBaseline = () => {
    baselineHeight = readLayoutViewportHeight(viewport);
    update();
  };

  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("orientationchange", resetBaseline);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", update);
  update();

  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("orientationchange", resetBaseline);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", update);
    setKeyboardOpen(false);
  };
}
