import type { Root } from "hast";

const INLINE_RICH_SYNTAX = /[\\`*_<>~&|{}]|\[|\]/u;
const AUTOLINK = /(?:https?:\/\/|www\.)\S|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/iu;
const BLOCK_SYNTAX =
  /^ {0,3}(?:#{1,6}(?:[ \t]+|$)|>|[-+](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$)|(?:=+|-+)[ \t]*$)/u;

/**
 * Returns the exact single-paragraph tree for syntax-free Markdown, or null
 * when the full parser is needed. The checks intentionally reject ambiguous
 * input: false negatives cost a lazy import, while false positives would
 * change rendered Markdown behavior.
 */
export function createPlainMarkdownTree(
  source: string,
  options: { readonly mathEnabled: boolean },
): Root | null {
  if (
    source.trim() !== source ||
    source.includes("\r") ||
    INLINE_RICH_SYNTAX.test(source) ||
    (options.mathEnabled && source.includes("$")) ||
    AUTOLINK.test(source)
  ) {
    return null;
  }

  const lines = source.split("\n");
  if (
    lines.some((line, index) => {
      return (
        (lines.length > 1 && line.trim() === "") ||
        BLOCK_SYNTAX.test(line) ||
        line.startsWith("    ") ||
        line.startsWith("\t") ||
        (index < lines.length - 1 && / {2,}$/u.test(line))
      );
    })
  ) {
    return null;
  }

  return {
    type: "root",
    children:
      source === ""
        ? []
        : [
            {
              type: "element",
              tagName: "p",
              properties: {},
              children: [{ type: "text", value: source }],
            },
          ],
  };
}

/** The text represented by an exact plain tree, including an empty tree. */
export function plainTextFromMarkdownTree(tree: Root): string | null {
  if (tree.children.length === 0) {
    return "";
  }
  if (tree.children.length !== 1) {
    return null;
  }
  const paragraph = tree.children[0];
  if (
    paragraph?.type !== "element" ||
    paragraph.tagName !== "p" ||
    Object.keys(paragraph.properties).length !== 0 ||
    paragraph.children.length !== 1
  ) {
    return null;
  }
  const text = paragraph.children[0];
  return text?.type === "text" ? text.value : null;
}
