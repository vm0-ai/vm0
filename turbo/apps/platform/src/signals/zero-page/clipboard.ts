import { command, computed, state } from "ccstate";

const internalCopyStatus$ = state<"idle" | "copied">("idle");

const internalCopyTimeoutId$ = state<number | null>(null);

export const copyStatus$ = computed((get) => {
  return get(internalCopyStatus$);
});

/**
 * Copy text to clipboard and show "copied" status for 5 seconds.
 */
export const copyToClipboard$ = command(({ get, set }, text: string) => {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const existingTimeoutId = get(internalCopyTimeoutId$);
      if (existingTimeoutId !== null) {
        window.clearTimeout(existingTimeoutId);
      }

      set(internalCopyStatus$, "copied");

      const timeoutId = window.setTimeout(() => {
        set(internalCopyStatus$, "idle");
        set(internalCopyTimeoutId$, null);
      }, 5000);
      set(internalCopyTimeoutId$, timeoutId);
    })
    .catch(() => {
      // Clipboard access may fail in some environments
    });
});
