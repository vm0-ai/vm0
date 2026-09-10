import { command, computed, state } from "ccstate";
import { now } from "../lib/time.ts";
import { onRef, setLoop } from "./utils.ts";

const NEXT_TIP = {
  employee: "model",
  model: "schedule",
  schedule: "cloud",
  cloud: "ideas",
  ideas: "workflow",
  workflow: "ask",
  ask: "support",
  support: "employee",
} as const;

const internalTip$ = state<keyof typeof NEXT_TIP>("employee");

export const appLoadingTip$ = computed((get) => {
  return get(internalTip$);
});

export const appLoadingTipsRef$ = onRef(
  command(async ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    set(internalTip$, "employee");
    let lastChange = now();
    let hovered = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    element.addEventListener(
      "pointerenter",
      () => {
        hovered = true;
      },
      { signal },
    );
    element.addEventListener(
      "pointerleave",
      () => {
        hovered = false;
      },
      { signal },
    );

    // Rotation belongs to the visible tip, including the bootstrap portal.
    // The ref's abort signal stops it when loading ends or the flag is disabled.
    await setLoop(
      () => {
        const currentTime = now();
        if (
          reducedMotion.matches ||
          document.hidden ||
          hovered ||
          element.contains(document.activeElement)
        ) {
          lastChange = currentTime;
          return false;
        }
        if (currentTime - lastChange >= 8000) {
          set(internalTip$, NEXT_TIP[get(internalTip$)]);
          lastChange = currentTime;
        }
        return false;
      },
      250,
      signal,
    );
  }),
);
