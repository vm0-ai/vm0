import { computed } from "ccstate";

import { createRetryableLazyModule } from "./retryable-lazy-module.ts";

const richMarkdown = createRetryableLazyModule(() => {
  return import("../views/components/rich-markdown.tsx");
});

export const loadRichMarkdown = richMarkdown.load;
export const getLoadedRichMarkdown = richMarkdown.getLoaded;
export const richMarkdownModule$ = computed(() => {
  return loadRichMarkdown();
});
