import type { KeyboardEvent } from "react";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  sendMode$,
  composing$,
  compositionStart$,
  compositionEnd$,
} from "../../signals/send-mode.ts";
import type { SendMode } from "@vm0/core";

/**
 * Returns keyboard and composition event handlers for the chat textarea
 * that respect the user's send-mode preference and IME composition state.
 *
 * - "enter": Enter sends, Shift+Enter inserts newline
 * - "cmd-enter": Cmd/Ctrl+Enter sends, Enter inserts newline
 *
 * Uses component-scoped composition state because on Chrome macOS the
 * `compositionend` event fires *before* the confirming `keydown`, making
 * `KeyboardEvent.isComposing` unreliable at that point.  With reactive
 * state the `composing` value captured in the render closure stays `true`
 * until the next render, so the keydown that follows compositionend in the
 * same tick is still correctly blocked.
 */
export function useSendKeyHandler(onSend: () => void) {
  const loadable = useLastLoadable(sendMode$);
  const mode: SendMode = loadable.state === "hasData" ? loadable.data : "enter";
  const composing = useGet(composing$);
  const onCompositionStart = useSet(compositionStart$);
  const onCompositionEnd = useSet(compositionEnd$);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing || e.nativeEvent.isComposing) {
      return;
    }
    if (e.key !== "Enter") {
      return;
    }
    if (window.matchMedia("(pointer: coarse)").matches) {
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
