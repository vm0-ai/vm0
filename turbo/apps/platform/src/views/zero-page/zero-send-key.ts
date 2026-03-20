import { useRef, type KeyboardEvent } from "react";
import { useLastLoadable } from "ccstate-react";
import { sendMode$ } from "../../signals/send-mode.ts";
import type { SendMode } from "@vm0/core";

/**
 * Returns keyboard and composition event handlers for the chat textarea
 * that respect the user's send-mode preference and IME composition state.
 *
 * - "enter": Enter sends, Shift+Enter inserts newline
 * - "cmd-enter": Cmd/Ctrl+Enter sends, Enter inserts newline
 *
 * Uses a manual composition ref because on Chrome macOS the `compositionend`
 * event fires *before* the confirming `keydown`, making
 * `KeyboardEvent.isComposing` unreliable at that point.
 */
export function useSendKeyHandler(onSend: () => void) {
  const loadable = useLastLoadable(sendMode$);
  const mode: SendMode = loadable.state === "hasData" ? loadable.data : "enter";
  const composingRef = useRef(false);

  const onCompositionStart = () => {
    composingRef.current = true;
  };

  const onCompositionEnd = () => {
    // Delay clearing so the Enter keydown that immediately follows
    // compositionend still sees the composing flag.
    requestAnimationFrame(() => {
      composingRef.current = false;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) {
      return;
    }
    if (e.key !== "Enter") {
      return;
    }
    const shouldSend =
      mode === "enter"
        ? !e.shiftKey && !e.metaKey && !e.ctrlKey
        : e.metaKey || e.ctrlKey;
    if (shouldSend) {
      e.preventDefault();
      onSend();
    }
  };

  return { onKeyDown, onCompositionStart, onCompositionEnd };
}
