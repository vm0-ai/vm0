/**
 * Rehype plugin that replaces ```mermaid fenced code blocks with a placeholder
 * `<div class="mermaid-block" data-mermaid-code="...">` element.
 *
 * It runs last in the shared Markdown pipeline, after raw HTML and attributes
 * have settled, so it can recognize the final fenced-code node without a view
 * component needing to inspect Markdown source.
 *
 * The placeholder must use a plain HTML tag name: react-markdown drops
 * elements whose tag name does not match `/^[A-Za-z0-9]+$/`.
 */

interface HastNode {
  data?: { mermaid?: { code: string } };
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface RehypeMermaidOptions {
  readonly closedFences: readonly boolean[];
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

/**
 * The diagram itself is a React component, so the tree only needs to say
 * "a diagram goes here". The payload rides on `data`, which `rehype-raw` cannot
 * produce — a message quoting `<div class="mermaid-block" data-mermaid-code>`
 * therefore stays a plain div instead of being swallowed by the renderer.
 */
function mermaidBlockNode(code: string): HastNode {
  return {
    type: "element",
    tagName: "div",
    properties: {},
    data: { mermaid: { code } },
    children: [],
  };
}

function replaceMermaidBlocks(
  node: HastNode,
  closedFences: readonly boolean[],
  nextFence: { index: number },
): void {
  const children = node.children;
  if (!children) {
    return;
  }
  for (const [index, child] of children.entries()) {
    const code = mermaidCodeElement(child);
    if (code) {
      const isClosed = closedFences[nextFence.index] ?? true;
      nextFence.index += 1;
      if (isClosed) {
        children[index] = mermaidBlockNode(
          collectText(code).replace(/\n$/, ""),
        );
      }
      continue;
    }
    replaceMermaidBlocks(child, closedFences, nextFence);
  }
}

export function rehypeMermaid(options: RehypeMermaidOptions) {
  return (tree: HastNode): void => {
    replaceMermaidBlocks(tree, options.closedFences, { index: 0 });
  };
}
