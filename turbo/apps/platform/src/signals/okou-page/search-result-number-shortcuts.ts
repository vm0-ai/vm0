import { command, computed, state } from "ccstate";
import { matchShortcut } from "@okouai/ui";
import { stableChatThreadNavigationEnabled$ } from "../external/feature-switch.ts";
import { onDomEventFn, onRef } from "../utils.ts";

type ShortcutModifiers = Pick<
  KeyboardEvent,
  "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

// Ref remounts must preserve modifiers captured by the shortcut that opens search.
// Closing the dialog resets this state through setThreeColumnSearchOpen$.
const internalSearchResultShortcutModifiersHeld$ = state(false);
export const searchResultShortcutHintsVisible$ = computed((get) => {
  return (
    get(stableChatThreadNavigationEnabled$) &&
    get(internalSearchResultShortcutModifiersHeld$)
  );
});

export const setSearchResultShortcutModifiers$ = command(
  ({ set }, event?: ShortcutModifiers) => {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
    set(
      internalSearchResultShortcutModifiersHeld$,
      event !== undefined &&
        event.shiftKey &&
        !event.altKey &&
        (isMac
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey),
    );
  },
);

export const setSearchResultShortcutElement$ = onRef(
  command(({ set }, element: HTMLElement, signal: AbortSignal) => {
    const doc = element.ownerDocument;
    const updateModifiers = onDomEventFn((event: KeyboardEvent) => {
      set(setSearchResultShortcutModifiers$, event);
    });
    const clearModifiers = onDomEventFn(() => {
      set(setSearchResultShortcutModifiers$);
    });
    doc.addEventListener("keydown", updateModifiers, { capture: true, signal });
    doc.addEventListener("keyup", updateModifiers, { capture: true, signal });
    doc.defaultView?.addEventListener("blur", clearModifiers, { signal });
    doc.addEventListener(
      "visibilitychange",
      onDomEventFn(() => {
        if (doc.hidden) {
          set(setSearchResultShortcutModifiers$);
        }
      }),
      { signal },
    );
  }),
);

export const searchResultShortcutIndex$ = command(
  ({ get }, event: KeyboardEvent): number | undefined => {
    if (
      !get(stableChatThreadNavigationEnabled$) ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return undefined;
    }
    for (let index = 0; index < 9; index++) {
      if (matchShortcut(`mod+shift+${index + 1}`, event)) {
        return index;
      }
    }
    return undefined;
  },
);
