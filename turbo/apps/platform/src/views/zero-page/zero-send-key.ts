import type { KeyboardEvent } from "react";
import { useGet } from "ccstate-react";
import { sendMode$ } from "../../signals/send-mode.ts";

/**
 * Returns a keydown handler for the chat textarea that respects the
 * user's send-mode preference.
 *
 * - "enter": Enter sends, Shift+Enter inserts newline
 * - "cmd-enter": Cmd/Ctrl+Enter sends, Enter inserts newline
 */
export function useSendKeyHandler(onSend: () => void) {
  const mode = useGet(sendMode$);

  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) {
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
}
