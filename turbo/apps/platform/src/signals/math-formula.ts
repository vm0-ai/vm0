import { computed } from "ccstate";
import type katex from "katex";

import { rootSignal$ } from "./root-signal.ts";

export type KatexBrowserRuntime = typeof katex;

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
export const katexBrowserRuntime$ = computed(async (get) => {
  const signal = get(rootSignal$);
  signal.throwIfAborted();
  // Formula rendering is an explicit optional boundary: this import runs only
  // after a parsed math node reaches the view, not during App startup.
  const { default: runtime } = await import("katex");
  signal.throwIfAborted();
  return runtime;
});
