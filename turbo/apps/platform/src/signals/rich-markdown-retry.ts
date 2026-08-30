import { command, computed, state } from "ccstate";

const internalRichMarkdownRetryVersion$ = state(0);

/** Invalidates rich Markdown preparation after a surfaced parse failure. */
export const richMarkdownRetryVersion$ = computed((get) => {
  return get(internalRichMarkdownRetryVersion$);
});

export const retryRichMarkdown$ = command(({ set }) => {
  set(internalRichMarkdownRetryVersion$, (version) => {
    return version + 1;
  });
});
