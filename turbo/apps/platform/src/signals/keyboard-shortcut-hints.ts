import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { stableChatThreadNavigationEnabled$ } from "./external/feature-switch.ts";
import { onDomEventFn, resetSignal } from "./utils.ts";

const internalKeyboardShortcutHintPhase$ = state<
  "idle" | "pending" | "visible"
>("idle");
const resetKeyboardShortcutHintHold$ = resetSignal();

export const keyboardShortcutHintsVisible$ = computed((get) => {
  return (
    get(stableChatThreadNavigationEnabled$) &&
    get(internalKeyboardShortcutHintPhase$) === "visible"
  );
});

export const hideKeyboardShortcutHints$ = command(({ get, set }) => {
  if (get(internalKeyboardShortcutHintPhase$) === "idle") {
    return;
  }
  set(resetKeyboardShortcutHintHold$);
  set(internalKeyboardShortcutHintPhase$, "idle");
});

const showKeyboardShortcutHints$ = command(
  async ({ set }, signal: AbortSignal) => {
    await delay(500, { signal });
    set(internalKeyboardShortcutHintPhase$, "visible");
  },
);

const updateKeyboardShortcutHintModifiers$ = command(
  ({ get, set }, event: KeyboardEvent, signal: AbortSignal) => {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
    // Safari's standalone thread-number shortcuts also require Control.
    const modifierHeld = isMac
      ? event.metaKey
      : event.ctrlKey && !event.metaKey;
    if (
      !get(stableChatThreadNavigationEnabled$) ||
      !modifierHeld ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing ||
      event.keyCode === 229 ||
      (event.type === "keydown" &&
        event.key !== "Meta" &&
        event.key !== "Control")
    ) {
      set(hideKeyboardShortcutHints$);
      return;
    }
    if (event.repeat || get(internalKeyboardShortcutHintPhase$) !== "idle") {
      return;
    }

    const holdSignal = set(resetKeyboardShortcutHintHold$, signal);
    set(internalKeyboardShortcutHintPhase$, "pending");
    return set(showKeyboardShortcutHints$, holdSignal);
  },
);

export const setupKeyboardShortcutHints$ = command(
  ({ set }, signal: AbortSignal) => {
    const updateModifiers = onDomEventFn((event: KeyboardEvent) => {
      return set(updateKeyboardShortcutHintModifiers$, event, signal);
    });
    const clearModifiers = onDomEventFn(() => {
      set(hideKeyboardShortcutHints$);
    });
    document.addEventListener("keydown", updateModifiers, {
      capture: true,
      signal,
    });
    document.addEventListener("keyup", updateModifiers, {
      capture: true,
      signal,
    });
    window.addEventListener("blur", clearModifiers, { signal });
    document.addEventListener(
      "visibilitychange",
      onDomEventFn(() => {
        if (document.visibilityState === "hidden") {
          set(hideKeyboardShortcutHints$);
        }
      }),
      { signal },
    );
    signal.addEventListener("abort", clearModifiers, { once: true });
  },
);
