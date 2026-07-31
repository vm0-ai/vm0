/**
 * Rehype plugin that replaces ```mermaid fenced code blocks with a placeholder
 * `<div class="mermaid-block" data-mermaid-code="...">` element.
 *
 * It has to run before `rehype-prism-plus`, which rewrites code content into
 * one `<span>` per line even for languages it does not know — after that the
 * original fence text can no longer be read reliably. Passing the plugin
 * through the `rehypePlugins` prop of `<Markdown>` gives exactly that position:
 * `@uiw/react-markdown-preview` appends its prism plugin after caller-provided
 * plugins.
 *
 * The placeholder must use a plain HTML tag name: react-markdown drops
 * elements whose tag name does not match `/^[A-Za-z0-9]+$/`.
 */

const MERMAID_BLOCK_CLASS = "mermaid-block";

interface HastNode {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Record<string, unknown>;
  children?: HastNode[];
}

function collectText(node: HastNode): string {
  if (node.type === "text") {
    return node.value ?? "";
  }
  return (node.children ?? []).map(collectText).join("");
}

function classNames(node: HastNode): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === "string";
    });
  }
  if (typeof value === "string") {
    return value.split(" ");
  }
  return [];
}

function mermaidCodeElement(node: HastNode): HastNode | undefined {
  if (node.type !== "element" || node.tagName !== "pre") {
    return undefined;
  }
  const code = (node.children ?? []).find((child) => {
    return child.type === "element" && child.tagName === "code";
  });
  if (!code || !classNames(code).includes("language-mermaid")) {
    return undefined;
  }
  return code;
}

function mermaidBlockNode(code: string): HastNode {
  return {
    type: "element",
    tagName: "div",
    properties: {
      className: [MERMAID_BLOCK_CLASS],
      dataMermaidCode: code,
    },
    children: [],
  };
}

function replaceMermaidBlocks(node: HastNode): void {
  const children = node.children;
  if (!children) {
    return;
  }
  for (const [index, child] of children.entries()) {
    const code = mermaidCodeElement(child);
    if (code) {
      children[index] = mermaidBlockNode(collectText(code).replace(/\n$/, ""));
      continue;
    }
    replaceMermaidBlocks(child);
  }
}

export function rehypeMermaid() {
  return (tree: HastNode): void => {
    replaceMermaidBlocks(tree);
  };
}
