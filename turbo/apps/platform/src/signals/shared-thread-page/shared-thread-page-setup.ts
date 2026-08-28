import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { command } from "ccstate";
import { createElement } from "react";

import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { createPlainMarkdownTree } from "../../lib/markdown/plain-markdown.ts";
import { loadRichMarkdown } from "../rich-markdown-module.ts";
import {
  SharedThreadPage,
  type SharedDisplayThread,
} from "../../views/shared-thread-page/shared-thread-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { apiClient$ } from "../api-client.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
} from "../mermaid-diagram.ts";
import {
  createImageLoadRegistry,
  embedImageLoadSignals,
} from "../image-load.ts";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import { setPageSignal$ } from "../page-signal.ts";

export const setupSharedThreadPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setPageSignal$, signal);
    const params = get(pathParams$);
    const id = String(params?.id ?? "");
    const client = get(apiClient$)(sharedThreadsContract);
    const result = await accept(
      client.get({ params: { id }, fetchOptions: { signal } }),
      [200, 404],
      signal,
    );
    // Page-scoped registries: repeated fences share one entry, and leaving
    // the page releases the diagrams it rendered.
    const mermaidDiagrams = createMermaidDiagramRegistry(signal);
    const imageLoads = createImageLoadRegistry();
    let sharedThread: SharedDisplayThread | null = null;
    if (result.status === 200) {
      const messages: SharedDisplayThread["messages"][number][] = [];
      let richMarkdown:
        | Awaited<ReturnType<typeof loadRichMarkdown>>
        | undefined;
      for (const message of result.body.messages) {
        if (message.role !== "assistant") {
          messages.push(message);
          continue;
        }
        let tree = createPlainMarkdownTree(message.content, {
          mathEnabled: true,
        });
        if (tree === null) {
          richMarkdown ??= await loadRichMarkdown();
          signal.throwIfAborted();
          tree = richMarkdown.parseMarkdownTree(message.content, {
            mathEnabled: true,
            mermaid: true,
          });
          embedMermaidSignals(tree, (code) => {
            return set(mermaidDiagrams.register$, code);
          });
          embedImageLoadSignals(tree, (url) => {
            return set(imageLoads.register$, url);
          });
        }
        messages.push({ ...message, tree });
      }
      sharedThread = { ...result.body, messages };
    }
    set(
      updateDocumentTitle$,
      sharedThread?.title ??
        i18n.t(($) => {
          return $.sharedThread.notFoundTitle;
        }),
    );
    set(updatePage$, createElement(SharedThreadPage, { sharedThread }));
    await set(hideAppSkeleton$, signal);
  },
);
