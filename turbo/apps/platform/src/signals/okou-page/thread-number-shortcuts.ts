import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { matchShortcut } from "@okouai/ui";
import { stableChatThreadNavigationEnabled$ } from "../external/feature-switch.ts";
import { onDomEventFn, resetSignal } from "../utils.ts";

const standaloneDisplayMode$ = state(false);
const shortcutHintPhase$ = state<"idle" | "pending" | "visible">("idle");
const resetShortcutHintHold$ = resetSignal();

export const threadNumberShortcutsEnabled$ = computed((get) => {
  return get(stableChatThreadNavigationEnabled$) && get(standaloneDisplayMode$);
});

export const threadNumberShortcutHintsVisible$ = computed((get) => {
  return (
    get(threadNumberShortcutsEnabled$) && get(shortcutHintPhase$) === "visible"
  );
});

export const clearThreadNumberShortcutHints$ = command(({ get, set }) => {
  if (get(shortcutHintPhase$) === "idle") {
    return;
  }
  set(resetShortcutHintHold$);
  set(shortcutHintPhase$, "idle");
});

const revealThreadNumberShortcutHints$ = command(
  async ({ set }, signal: AbortSignal) => {
    await delay(500, { signal });
    set(shortcutHintPhase$, "visible");
  },
);

const updateThreadNumberShortcutModifiers$ = command(
  ({ get, set }, event: KeyboardEvent, signal: AbortSignal) => {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
    const modifierHeld = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (
      !get(threadNumberShortcutsEnabled$) ||
      !modifierHeld ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      set(clearThreadNumberShortcutHints$);
      return;
    }
    if (event.repeat || get(shortcutHintPhase$) !== "idle") {
      return;
    }

    const holdSignal = set(resetShortcutHintHold$, signal);
    set(shortcutHintPhase$, "pending");
    return set(revealThreadNumberShortcutHints$, holdSignal);
  },
);

export const setupThreadNumberShortcuts$ = command(
  ({ set }, signal: AbortSignal) => {
    const displayModes = [
      window.matchMedia("(display-mode: standalone)"),
      window.matchMedia("(display-mode: window-controls-overlay)"),
    ];
    const updateDisplayMode = onDomEventFn(() => {
      set(
        standaloneDisplayMode$,
        displayModes.some((mode) => {
          return mode.matches;
        }),
      );
      set(clearThreadNumberShortcutHints$);
    });
    updateDisplayMode(undefined);
    for (const mode of displayModes) {
      mode.addEventListener("change", updateDisplayMode, { signal });
    }

    const updateModifiers = onDomEventFn((event: KeyboardEvent) => {
      return set(updateThreadNumberShortcutModifiers$, event, signal);
    });
    const clearModifiers = onDomEventFn(() => {
      set(clearThreadNumberShortcutHints$);
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
          set(clearThreadNumberShortcutHints$);
        }
      }),
      { signal },
    );
    signal.addEventListener("abort", clearModifiers, { once: true });
  },
);

export const threadNumberShortcutIndex$ = command(
  ({ get }, event: KeyboardEvent): number | undefined => {
    if (
      !get(threadNumberShortcutsEnabled$) ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229
    ) {
      return undefined;
    }
    for (let index = 0; index < 9; index++) {
      if (matchShortcut(`mod+${index + 1}`, event)) {
        return index;
      }
    }
    return undefined;
  },
);
