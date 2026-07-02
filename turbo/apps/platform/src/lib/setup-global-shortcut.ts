import { matchShortcut, isEditableTarget } from "@vm0/ui";
import { onDomEventFn } from "../signals/utils.ts";

type GlobalShortcutCallback = (e: KeyboardEvent) => void | Promise<void>;

export interface GlobalShortcutBinding {
  readonly allowInEditableTarget?: boolean;
  readonly run: GlobalShortcutCallback;
}

export type GlobalShortcutBindings = Record<string, GlobalShortcutBinding>;

interface GlobalShortcutSetupOptions {
  readonly doc?: Document;
  readonly shouldHandleEvent?: (e: KeyboardEvent) => boolean;
}

function hasOpenDialog(doc: Document): boolean {
  return doc.querySelector('[role="dialog"]') !== null;
}

/**
 * Attach keyboard shortcuts to `document` with automatic cleanup via AbortSignal.
 *
 * Callbacks are wrapped with `onDomEventFn` so they can be async (fire-and-forget
 * with proper abort-error handling). Text-entry targets are ignored by default;
 * individual bindings can opt in with `allowInEditableTarget`.
 */
export function setupGlobalShortcut(
  bindings: GlobalShortcutBindings,
  signal: AbortSignal,
  options: GlobalShortcutSetupOptions = {},
): void {
  const doc = options.doc ?? document;
  doc.addEventListener(
    "keydown",
    onDomEventFn((e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        hasOpenDialog(doc) ||
        options.shouldHandleEvent?.(e) === false
      ) {
        return;
      }
      for (const [shortcut, binding] of Object.entries(bindings)) {
        if (matchShortcut(shortcut, e)) {
          if (isEditableTarget(e.target) && !binding.allowInEditableTarget) {
            return;
          }
          e.preventDefault();
          return binding.run(e);
        }
      }
    }),
    { signal },
  );
}
