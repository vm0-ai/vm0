import { sharedThreadsContract } from "@vm0/api-contracts/contracts/shared-threads";
import { command } from "ccstate";
import { createElement } from "react";

import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { parseMarkdownTree } from "../../lib/markdown/pipeline.ts";
import {
  SharedThreadPage,
  type SharedDisplayThread,
} from "../../views/shared-thread-page/shared-thread-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { zeroClient$ } from "../api-client.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import {
  embedMermaidSignals,
  registerMermaidDiagram$,
} from "../mermaid-diagram.ts";
import { embedImageLoadSignals, registerImageLoad$ } from "../image-load.ts";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import { setPageSignal$ } from "../page-signal.ts";

export const setupSharedThreadPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setPageSignal$, signal);
    const params = get(pathParams$);
    const id = String(params?.id ?? "");
    const client = get(zeroClient$)(sharedThreadsContract);
    const result = await accept(
      client.get({ params: { id }, fetchOptions: { signal } }),
      [200, 404],
      signal,
    );
    const sharedThread: SharedDisplayThread | null =
      result.status === 200
        ? {
            ...result.body,
            // Assistant bodies parse once here, with their diagram signals
            // embedded, so the page renders trees the same way the chat
            // transcript does.
            messages: result.body.messages.map((message) => {
              if (message.role !== "assistant") {
                return message;
              }
              const tree = parseMarkdownTree(message.content, {
                mathEnabled: true,
                mermaid: true,
              });
              embedMermaidSignals(tree, (code) => {
                return set(registerMermaidDiagram$, code);
              });
              embedImageLoadSignals(tree, (url) => {
                return set(registerImageLoad$, url);
              });
              return { ...message, tree };
            }),
          }
        : null;
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
