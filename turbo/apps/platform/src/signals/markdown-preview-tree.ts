import { computed, type Computed } from "ccstate";
import type { Root } from "hast";

import { parseMarkdownTree } from "../lib/markdown/pipeline.ts";
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
 * only changes when the whole preview is replaced.
 */
export function createMarkdownPreviewTree(
  text$: TextPreviewComputed,
): MarkdownPreviewTreeComputed {
  return computed(async (get): Promise<Root> => {
    const tree = parseMarkdownTree(await get(text$), {
      mathEnabled: false,
      mermaid: true,
    });
    embedMermaidSignals(tree, createMermaidDiagramSignals);
    return tree;
  });
}
