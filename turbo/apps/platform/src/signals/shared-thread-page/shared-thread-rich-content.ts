import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Root } from "hast";

import {
  createImageLoadRegistry,
  embedImageLoadSignals,
} from "../image-load.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
} from "../mermaid-diagram.ts";
import {
  retryRichMarkdownModule$,
  richMarkdownModule$,
} from "../rich-markdown-module.ts";
import { tapError } from "../utils.ts";

export interface SharedThreadRichContentState {
  readonly status: "loading" | "error" | "ready";
  readonly trees: ReadonlyMap<number, Root>;
}

export interface SharedThreadRichContentSignals {
  readonly state$: Computed<SharedThreadRichContentState>;
  readonly load$: Command<Promise<void>, [AbortSignal]>;
  readonly retry$: Command<Promise<void>, []>;
}

/**
 * Loads and prepares only the rich bodies of one immutable shared thread. The
 * page publishes its plain messages before starting `load$`; this state keeps
 * the loading and error lifecycle local to each pending rich body.
 */
export function createSharedThreadRichContentSignals(
  messages: readonly SharedMessage[],
  ownerSignal: AbortSignal,
): SharedThreadRichContentSignals {
  const mermaidDiagrams = createMermaidDiagramRegistry(ownerSignal);
  const imageLoads = createImageLoadRegistry();
  const emptyTrees: ReadonlyMap<number, Root> = new Map();
  const internalState$ = state<SharedThreadRichContentState>({
    status: "loading",
    trees: emptyTrees,
  });
  const state$ = computed((get) => {
    return get(internalState$);
  });

  const load$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      set(internalState$, (current): SharedThreadRichContentState => {
        return { status: "loading", trees: current.trees };
      });
      const modulePromise = get(richMarkdownModule$);
      const trees = await tapError(
        (async (): Promise<ReadonlyMap<number, Root>> => {
          const richMarkdown = await modulePromise;
          signal.throwIfAborted();
          const next = new Map<number, Root>();
          for (const message of messages) {
            const tree = richMarkdown.parseMarkdownTree(message.content, {
              mathEnabled: true,
              mermaid: true,
            });
            embedMermaidSignals(tree, (code) => {
              return set(mermaidDiagrams.register$, code);
            });
            embedImageLoadSignals(tree, (url) => {
              return set(imageLoads.register$, url);
            });
            next.set(message.messageIndex, tree);
          }
          signal.throwIfAborted();
          return next;
        })(),
        () => {
          set(internalState$, (current): SharedThreadRichContentState => {
            return { status: "error", trees: current.trees };
          });
        },
      );
      signal.throwIfAborted();
      if (trees === undefined) {
        return;
      }
      set(internalState$, { status: "ready", trees });
    },
  );

  const retry$ = command(({ set }): Promise<void> => {
    ownerSignal.throwIfAborted();
    set(retryRichMarkdownModule$);
    return set(load$, ownerSignal);
  });

  return { load$, retry$, state$ };
}
