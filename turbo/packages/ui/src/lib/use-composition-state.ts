import { useCallback, useState } from "react";

/**
 * Track IME composition state for keyboard shortcut handling.
 *
 * On Chrome macOS the `compositionend` event fires *before* the confirming
 * `keydown`, making `KeyboardEvent.isComposing` unreliable at that point.
 * With React state the value captured in the render closure stays `true`
 * until the next render, so the keydown that follows compositionend in the
 * same tick is still correctly blocked.
 */
export function useCompositionState() {
  const [isComposing, setIsComposing] = useState(false);

  const onCompositionStart = useCallback(() => {
    setIsComposing(true);
  }, []);

  const onCompositionEnd = useCallback(() => {
    setIsComposing(false);
  }, []);

  return { isComposing, onCompositionStart, onCompositionEnd };
}
