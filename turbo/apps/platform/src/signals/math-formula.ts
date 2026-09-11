import { computed } from "ccstate";
import type katex from "katex";

export type KatexBrowserRuntime = typeof katex;

export const katexBrowserRuntime$ = computed(async () => {
  // Formula rendering is an explicit optional boundary: this import runs only
  // after a parsed math node reaches the view, not during App startup.
  const { default: runtime } = await import("katex");
  return runtime;
});
