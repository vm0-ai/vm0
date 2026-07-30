const DISMISS_SWIPE_THRESHOLD_PX = 24;
const GESTURE_INTENT_SLOP_PX = 4;
const COMPOSER_CONTAINER_SELECTOR = "[data-chat-composer]";
const CHAT_HISTORY_CONTAINER_SELECTOR = "[data-scroll-container]";
const STANDALONE_DISPLAY_MODE_QUERY = "(display-mode: standalone)";

// "locked" gestures suppress native panning so the composer cannot be dragged
// away from the keyboard; "pass-through" gestures keep native scrolling (chat
// history, or a composer editor with its own scrollable draft).
type GestureIntent = "undecided" | "locked" | "pass-through";

interface DismissGesture {
  composerEl: HTMLElement | null;
  dismissed: boolean;
  intent: GestureIntent;
  startX: number;
  startY: number;
  target: Element;
}

function isKeyboardOpen(): boolean {
  return document.documentElement.dataset.keyboardOpen === "true";
}

export function isStandalonePwa(): boolean {
  return window.matchMedia(STANDALONE_DISPLAY_MODE_QUERY).matches;
}

function blurKeyboardTarget(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }
}

function isVerticalScrollContainer(element: HTMLElement): boolean {
  const overflowY = getComputedStyle(element).overflowY;
  if (overflowY !== "auto" && overflowY !== "scroll") {
    return false;
  }
  return element.scrollHeight > element.clientHeight;
}

function canConsumeVerticalSwipe(
  element: HTMLElement,
  deltaY: number,
): boolean {
  // A downward swipe (positive deltaY) scrolls content toward its start; an
  // upward swipe scrolls toward its end.
  if (deltaY > 0) {
    return element.scrollTop > 0;
  }
  return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
}

function hasVerticalScrollConsumer(
  target: Element,
  boundary: HTMLElement,
  deltaY: number,
): boolean {
  let node: Element | null = target;
  while (node) {
    if (
      node instanceof HTMLElement &&
      isVerticalScrollContainer(node) &&
      canConsumeVerticalSwipe(node, deltaY)
    ) {
      return true;
    }
    if (node === boundary) {
      break;
    }
    node = node.parentElement;
  }
  return false;
}

function resolveGestureIntent(
  gesture: DismissGesture,
  deltaX: number,
  deltaY: number,
): GestureIntent {
  if (
    Math.abs(deltaX) < GESTURE_INTENT_SLOP_PX &&
    Math.abs(deltaY) < GESTURE_INTENT_SLOP_PX
  ) {
    return "undecided";
  }
  if (!gesture.composerEl) {
    return "pass-through";
  }
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return "pass-through";
  }
  if (hasVerticalScrollConsumer(gesture.target, gesture.composerEl, deltaY)) {
    return "pass-through";
  }
  return "locked";
}

export function setupKeyboardDismissGesture(): () => void {
  if (!isStandalonePwa()) {
    return () => {};
  }

  let gesture: DismissGesture | null = null;

  const clearGesture = () => {
    gesture = null;
  };

  const onTouchStart = (event: TouchEvent) => {
    gesture = null;
    if (event.touches.length !== 1 || !isKeyboardOpen()) {
      return;
    }
    const touch = event.touches[0];
    const target = event.target;
    if (!touch || !(target instanceof Element)) {
      return;
    }
    const composerEl = target.closest(COMPOSER_CONTAINER_SELECTOR);
    if (!composerEl && !target.closest(CHAT_HISTORY_CONTAINER_SELECTOR)) {
      return;
    }
    gesture = {
      composerEl: composerEl instanceof HTMLElement ? composerEl : null,
      dismissed: false,
      intent: "undecided",
      startX: touch.clientX,
      startY: touch.clientY,
      target,
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!gesture) {
      return;
    }
    if (event.touches.length !== 1) {
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;

    if (gesture.intent === "undecided") {
      gesture.intent = resolveGestureIntent(gesture, deltaX, deltaY);
    }
    if (gesture.intent === "locked" && event.cancelable) {
      // Keep the composer pinned above the keyboard: without this, the drag
      // pans the standalone-PWA page scroller (or the visual viewport) and
      // detaches the input bar from the keyboard.
      event.preventDefault();
    }
    if (
      !gesture.dismissed &&
      (!gesture.composerEl || gesture.intent === "locked") &&
      deltaY >= DISMISS_SWIPE_THRESHOLD_PX &&
      deltaY > Math.abs(deltaX) &&
      isKeyboardOpen()
    ) {
      gesture.dismissed = true;
      blurKeyboardTarget();
    }
  };

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", clearGesture, { passive: true });
  document.addEventListener("touchcancel", clearGesture, { passive: true });

  return () => {
    document.removeEventListener("touchstart", onTouchStart);
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", clearGesture);
    document.removeEventListener("touchcancel", clearGesture);
    clearGesture();
  };
}
