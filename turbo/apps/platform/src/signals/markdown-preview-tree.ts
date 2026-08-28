import { computed, type Computed, type State } from "ccstate";
import type { Root } from "hast";

import { createPlainMarkdownTree } from "../lib/markdown/plain-markdown.ts";
import {
  richMarkdownModule$,
  richMarkdownRetryVersion$,
} from "./rich-markdown-module.ts";
import {
  createMermaidDiagramSignals,
  embedMermaidSignals,
} from "./mermaid-diagram.ts";
import type { TextPreviewComputed } from "./text-preview.ts";

export type MarkdownPreviewTreeComputed = Computed<Promise<Root>>;

/**
 * The rendered tree of a markdown preview (a `.md` artifact or attachment).
 * Created wherever the preview's text computed is attached — the command that
 * opens the preview — so the view renders a prepared tree with its diagram
 * signals embedded instead of parsing during render. Diagram signals are
 * created per tree rather than through the chat registry: a preview's content
 * only changes when the whole preview is replaced. A readable owner lets a
 * reusable computed pick up each newly opened preview session's lifetime.
 */
export function createMarkdownPreviewTree(
  text$: TextPreviewComputed,
  owner: AbortSignal | Computed<AbortSignal> | State<AbortSignal>,
): MarkdownPreviewTreeComputed {
  return computed(async (get): Promise<Root> => {
    // The preview's error surface can explicitly retry either its source or
    // the rich-content chunk without replacing an otherwise unchanged file.
    get(richMarkdownRetryVersion$);
    const ownerSignal = "aborted" in owner ? owner : get(owner);
    const source = await get(text$);
    ownerSignal.throwIfAborted();
    const plainTree = createPlainMarkdownTree(source, { mathEnabled: false });
    if (plainTree !== null) {
      return plainTree;
    }
    const richMarkdown = await get(richMarkdownModule$);
    ownerSignal.throwIfAborted();
    const tree = richMarkdown.parseMarkdownTree(source, {
      mathEnabled: false,
      mermaid: true,
    });
    ownerSignal.throwIfAborted();
    embedMermaidSignals(tree, (code) => {
      return createMermaidDiagramSignals(code, ownerSignal);
    });
    return tree;
  });
}
