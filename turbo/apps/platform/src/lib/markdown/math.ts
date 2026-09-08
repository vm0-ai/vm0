import type { Root } from "hast";
import type {
  MarkedExtension,
  TokenizerAndRendererExtension,
  Tokens,
} from "marked";
import { visit } from "unist-util-visit";

export interface MarkdownMath {
  readonly displayMode: boolean;
  readonly raw: string;
  readonly source: string | null;
}

declare module "hast" {
  interface Data {
    math?: MarkdownMath;
  }
}

const MAX_SOURCE_LENGTH = 10_000;
const BLOCK_TOKEN = "okouMathBlock";
const INLINE_TOKEN = "okouMathInline";
const NEXT_BLOCK = /\n {0,3}(?:\\\[|\$\$)/u;
const INLINE = /^\\\(([^\n]*?)\\\)/u;
const BRACKET_BLOCK =
  /^ {0,3}\\\[(?:([^\n]*?)\\\][ \t]*(?:\n|$)|[ \t]*\n([\s\S]*?)^ {0,3}\\\][ \t]*(?:\n|$))/mu;
const DOLLAR_BLOCK =
  /^ {0,3}\$\$(?:([^\n]*?)\$\$[ \t]*(?:\n|$)|[ \t]*\n([\s\S]*?)^ {0,3}\$\$[ \t]*(?:\n|$))/mu;

interface MathToken {
  readonly raw: string;
  readonly source: string | null;
  readonly type: string;
}

function renderableSource(source: string): string | null {
  const trimmed = source.trim();
  return trimmed !== "" && trimmed.length <= MAX_SOURCE_LENGTH ? trimmed : null;
}

function blockMathToken(source: string): MathToken | undefined {
  const match = /^ {0,3}\\\[/u.test(source)
    ? BRACKET_BLOCK.exec(source)
    : /^ {0,3}\$\$/u.test(source)
      ? DOLLAR_BLOCK.exec(source)
      : null;
  if (match?.index === 0) {
    return {
      type: BLOCK_TOKEN,
      raw: match[0],
      source: renderableSource(match[1] ?? match[2] ?? ""),
    };
  }
  return undefined;
}

function inlineMathToken(source: string): MathToken | undefined {
  const match = INLINE.exec(source);
  return match
    ? {
        type: INLINE_TOKEN,
        raw: match[0],
        source: renderableSource(match[1] ?? ""),
      }
    : undefined;
}

function embedMath(
  tree: Root,
  marker: string,
  formulas: readonly MarkdownMath[],
): void {
  visit(tree, "comment", (node, index, parent) => {
    if (index === undefined || !parent || !node.value.startsWith(marker)) {
      return;
    }
    const formula = formulas[Number(node.value.slice(marker.length))];
    if (!formula) {
      throw new Error("Markdown math marker is invalid");
    }
    parent.children[index] = {
      type: "element",
      tagName: formula.displayMode ? "div" : "span",
      properties: {},
      data: { math: formula },
      children: [{ type: "text", value: formula.raw }],
    };
  });
}

interface MarkdownMathContext {
  readonly embed: (tree: Root) => void;
  readonly extension: MarkedExtension;
}

export function createMarkdownMathContext(): MarkdownMathContext {
  const marker = `okou-math:${crypto.randomUUID()}:`;
  const formulas: MarkdownMath[] = [];
  const render = (token: Tokens.Generic): string => {
    const formula: MarkdownMath = {
      displayMode: token.type === BLOCK_TOKEN,
      raw:
        token.type === BLOCK_TOKEN ? token.raw.replace(/\n+$/u, "") : token.raw,
      source: typeof token.source === "string" ? token.source : null,
    };
    const index = formulas.push(formula) - 1;
    return `<!--${marker}${index}-->${formula.displayMode ? "\n" : ""}`;
  };
  const block: TokenizerAndRendererExtension = {
    name: BLOCK_TOKEN,
    level: "block",
    start(source) {
      return NEXT_BLOCK.exec(source)?.index;
    },
    tokenizer: blockMathToken,
    renderer: render,
  };
  const inline: TokenizerAndRendererExtension = {
    name: INLINE_TOKEN,
    level: "inline",
    start(source) {
      const index = source.indexOf(String.raw`\(`);
      return index === -1 ? undefined : index;
    },
    tokenizer: inlineMathToken,
    renderer: render,
  };
  return {
    extension: { extensions: [block, inline] },
    embed(tree) {
      embedMath(tree, marker, formulas);
    },
  };
}
