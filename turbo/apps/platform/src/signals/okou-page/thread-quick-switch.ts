import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  featureSwitch$,
  stableChatThreadNavigationEnabled$,
} from "../external/feature-switch.ts";
import { keyboardShortcutHintsVisible$ } from "../keyboard-shortcut-hints.ts";

export const THREAD_QUICK_SWITCH_KEYS = ["a", "s", "d", "f", "g"] as const;

export const threadQuickSwitchEnabled$ = computed((get) => {
  return (
    get(stableChatThreadNavigationEnabled$) &&
    get(featureSwitch$)[FeatureSwitchKey.ChatQuickSwitch] &&
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  );
});

export const threadQuickSwitchHintsVisible$ = computed((get) => {
  return get(threadQuickSwitchEnabled$) && get(keyboardShortcutHintsVisible$);
});

export const threadQuickSwitchIndex$ = command(
  ({ get }, event: KeyboardEvent): number | undefined => {
    if (
      !get(threadQuickSwitchEnabled$) ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return undefined;
    }
    // Option produces characters such as å and ß; identify the physical key.
    const index = THREAD_QUICK_SWITCH_KEYS.findIndex((key) => {
      return event.code === `Key${key.toUpperCase()}`;
    });
    return index === -1 ? undefined : index;
  },
);
