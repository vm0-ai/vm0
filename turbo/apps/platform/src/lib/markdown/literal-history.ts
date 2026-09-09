import type { Root } from "hast";

/** Render already-identified literal history without interpreting HTML or Markdown. */
export function literalHistoryTree(content: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        properties: { className: ["whitespace-pre-wrap"] },
        children: [{ type: "text", value: content }],
      },
    ],
  };
}
