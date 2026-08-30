import type { Element, Root, RootContent } from "hast";
import { getCodeString } from "rehype-rewrite";

/**
 * App-owned Markdown tree augmentations for heading anchors and code-copy
 * controls. The behavior was ported from @uiw/react-markdown-preview@5.2.0
 * under its MIT license.
 */

/** The anchor icon injected into headings. */
function octiconLink(): Element {
  return {
    type: "element",
    tagName: "svg",
    properties: {
      className: ["octicon", "octicon-link"],
      viewBox: "0 0 16 16",
      version: "1.1",
      width: "16",
      height: "16",
      ariaHidden: "true",
    },
    children: [
      {
        type: "element",
        tagName: "path",
        children: [],
        properties: {
          fillRule: "evenodd",
          d: "M7.775 3.275a.75.75 0 001.06 1.06l1.25-1.25a2 2 0 112.83 2.83l-2.5 2.5a2 2 0 01-2.83 0 .75.75 0 00-1.06 1.06 3.5 3.5 0 004.95 0l2.5-2.5a3.5 3.5 0 00-4.95-4.95l-1.25 1.25zm-4.69 9.64a2 2 0 010-2.83l2.5-2.5a2 2 0 012.83 0 .75.75 0 001.06-1.06 3.5 3.5 0 00-4.95 0l-2.5 2.5a3.5 3.5 0 004.95 4.95l1.25-1.25a.75.75 0 00-1.06-1.06l-1.25 1.25a2 2 0 01-2.83 0z",
        },
      },
    ],
  };
}

/**
 * A marker for the copy button appended to every code block. Only the marker
 * lives in the tree; the button itself is a React
 * component, so the click handler is an ordinary `onClick`. The payload rides
 * on `data`, which parsed HTML cannot produce, so quoted HTML cannot forge it.
 */
function copyElement(code: string): Element {
  return {
    type: "element",
    tagName: "div",
    properties: {},
    data: { copyCode: code },
    children: [],
  };
}

type RewriteHandler = (
  node: RootContent,
  index: number | undefined,
  parent: Root | Element | undefined,
) => void;

/**
 * Swaps the autolink-headings anchor content for the octicon and appends a copy
 * button to every code block.
 */
export function rehypeRewriteHandle(rewrite: RewriteHandler): RewriteHandler {
  return (node, index, parent) => {
    if (
      node.type === "element" &&
      parent &&
      parent.type === "root" &&
      /h[1-6]/.test(node.tagName)
    ) {
      const child = node.children[0];
      if (
        child &&
        child.type === "element" &&
        child.properties.ariaHidden === "true"
      ) {
        child.properties = { class: "anchor", ...child.properties };
        child.children = [octiconLink()];
      }
    }

    if (node.type === "element" && node.tagName === "pre") {
      node.children.push(copyElement(getCodeString(node.children)));
    }

    rewrite(node, index, parent);
  };
}
