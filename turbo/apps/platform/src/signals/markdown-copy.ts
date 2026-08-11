import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";

import { resetSignal } from "./utils.ts";

/**
 * The markdown pipeline marks every code block with a copy button. The button
 * is a React component, so copying is a plain command; this state only drives
 * the "copied" confirmation, keyed by the copied text because that is the only
 * identity a code block has.
 */
const internalCopiedMarkdownCode$ = state<ReadonlySet<string>>(new Set());

export const copiedMarkdownCode$ = computed((get) => {
  return get(internalCopiedMarkdownCode$);
});

const setCopiedMarkdownCode$ = command(
  ({ get, set }, code: string, copied: boolean) => {
    const next = new Set(get(internalCopiedMarkdownCode$));
    if (copied) {
      next.add(code);
    } else {
      next.delete(code);
    }
    set(internalCopiedMarkdownCode$, next);
  },
);

// The confirmation owns its lifetime: copying again cancels the previous
// countdown. Binding it to the page instead would make every markdown view
// depend on a page setup, which the shared thread and preview surfaces render
// without.
const copyFeedbackSignal$ = resetSignal();

const runCopyMarkdownCode$ = command(
  async ({ set }, code: string, signal: AbortSignal) => {
    await navigator.clipboard.writeText(code);
    signal.throwIfAborted();
    set(setCopiedMarkdownCode$, code, true);
    await delay(2000, { signal });
    set(setCopiedMarkdownCode$, code, false);
  },
);

export const copyMarkdownCode$ = command(
  ({ set }, code: string): Promise<void> => {
    return set(runCopyMarkdownCode$, code, set(copyFeedbackSignal$));
  },
);
