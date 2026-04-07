import { command, computed, state } from "ccstate";
import { throwIfAbort } from "../utils.ts";

/**
 * Write text to the clipboard with a legacy fallback.
 *
 * Tries the Clipboard API first. When it throws (e.g. NotAllowedError on iOS
 * Safari after an async boundary loses the user-gesture context), falls back to
 * the deprecated `document.execCommand("copy")` approach.
 *
 * Returns `true` if the text was copied, `false` if both methods failed.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error: unknown) {
    throwIfAbort(error);
    // Clipboard API can throw NotAllowedError on iOS Safari when the user
    // gesture context is lost (e.g. after an async boundary). Fall back to
    // the legacy execCommand approach.
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      return true;
    } catch (fallbackError: unknown) {
      throwIfAbort(fallbackError);
      return false;
    }
  }
}

const internalCopyStatus$ = state<"idle" | "copied">("idle");

const internalCopyTimeoutId$ = state<number | null>(null);

export const copyStatus$ = computed((get) => {
  return get(internalCopyStatus$);
});

/**
 * Copy text to clipboard and show "copied" status for 5 seconds.
 */
export const copyToClipboard$ = command(
  async ({ get, set }, text: string, signal: AbortSignal) => {
    const ok = await writeToClipboard(text);
    signal.throwIfAborted();
    if (!ok) {
      return;
    }

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
  },
);
