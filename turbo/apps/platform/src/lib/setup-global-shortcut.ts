import { matchShortcut, isEditableTarget } from "@vm0/ui";
import { onDomEventFn } from "../signals/utils.ts";

/**
 * Attach keyboard shortcuts to `document` with automatic cleanup via AbortSignal.
 *
 * Callbacks are wrapped with `onDomEventFn` so they can be async (fire-and-forget
 * with proper abort-error handling). Events originating from INPUT, TEXTAREA,
 * or contentEditable elements are automatically ignored.
 */
export function setupGlobalShortcut(
  bindings: Record<string, (e: KeyboardEvent) => void | Promise<void>>,
  signal: AbortSignal,
): void {
  document.addEventListener(
    "keydown",
    onDomEventFn((e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) {
        return;
      }
      for (const [shortcut, callback] of Object.entries(bindings)) {
        if (matchShortcut(shortcut, e)) {
          e.preventDefault();
          return callback(e);
        }
      }
    }),
    { signal },
  );
}
