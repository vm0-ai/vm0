import { command, computed, state } from "ccstate";

import { IN_VITEST } from "../env.ts";
import { createRetryableLazyModule } from "./retryable-lazy-module.ts";

export type RichMarkdownModule =
  typeof import("../views/components/rich-markdown.tsx");
export type RichMarkdownImporter = () => Promise<RichMarkdownModule>;

declare global {
  interface Window {
    vm0RichMarkdownImporterForTest?: RichMarkdownImporter;
  }
}

const richMarkdown = createRetryableLazyModule(() => {
  const testImporter = IN_VITEST
    ? window.vm0RichMarkdownImporterForTest
    : undefined;
  return testImporter?.() ?? import("../views/components/rich-markdown.tsx");
});

const internalRichMarkdownRetryVersion$ = state(0);

export const loadRichMarkdown = richMarkdown.load;
export const getLoadedRichMarkdown = richMarkdown.getLoaded;
export const richMarkdownRetryVersion$ = computed((get) => {
  return get(internalRichMarkdownRetryVersion$);
});
export const retryRichMarkdownModule$ = command(({ set }) => {
  set(internalRichMarkdownRetryVersion$, (version) => {
    return version + 1;
  });
});
export const richMarkdownModule$ = computed((get) => {
  get(richMarkdownRetryVersion$);
  return loadRichMarkdown();
});
