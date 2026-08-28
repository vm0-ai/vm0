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

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/;

interface HastPoint {
  readonly offset?: number;
}

interface HastNode {
  data?: { mermaid?: { code: string } };
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Record<string, unknown>;
  readonly position?: { readonly start: HastPoint; readonly end: HastPoint };
  children?: HastNode[];
}

interface MarkdownFile {
  readonly value?: unknown;
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
 * A streaming assistant message reaches this plugin mid-fence, and markdown
 * parses an unterminated fence as a code block, so the diagram source would be
 * a fragment that changes with every chunk. Only the closing delimiter tells a
 * finished diagram from one that is still arriving; without position data
 * (no source available) the block is treated as finished, as before.
 */
function isClosedFence(node: HastNode, source: string): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    return true;
  }
  const lines = source.slice(start, end).trimEnd().split("\n");
  const opening = FENCE_OPENING.exec(lines[0] ?? "")?.[1];
  const closing = lines.length > 1 ? lines[lines.length - 1] : undefined;
  if (opening === undefined || closing === undefined) {
    return true;
  }
  // CommonMark: the closing delimiter is the same character, at least as long
  // as the opening one, and carries nothing else.
  const trimmed = closing.replace(/^ {0,3}/, "");
  return (
    trimmed.length >= opening.length &&
    [...trimmed].every((character) => {
      return character === opening[0];
    })
  );
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

function replaceMermaidBlocks(node: HastNode, source: string): void {
  const children = node.children;
  if (!children) {
    return;
  }
  for (const [index, child] of children.entries()) {
    const code = mermaidCodeElement(child);
    if (code) {
      if (isClosedFence(child, source)) {
        children[index] = mermaidBlockNode(
          collectText(code).replace(/\n$/, ""),
        );
      }
      continue;
    }
    replaceMermaidBlocks(child, source);
  }
}

export function rehypeMermaid() {
  return (tree: HastNode, file: MarkdownFile): void => {
    replaceMermaidBlocks(
      tree,
      typeof file.value === "string" ? file.value : "",
    );
  };
}
