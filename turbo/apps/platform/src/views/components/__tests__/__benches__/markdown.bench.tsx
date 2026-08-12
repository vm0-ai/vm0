import { cleanup, render } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import type { Root } from "hast";
import { bench, describe } from "vitest";

import { parseMarkdownTree } from "../../../../lib/markdown/pipeline.ts";
import {
  createImageLoadSignals,
  embedImageLoadSignals,
} from "../../../../signals/image-load.ts";
import {
  createMermaidDiagramSignals,
  embedMermaidSignals,
} from "../../../../signals/mermaid-diagram.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { MarkdownEventBody } from "../../markdown.tsx";

// ---------------------------------------------------------------------------
// Chat markdown pipeline benchmarks.
//
// The transcript pays two separable costs: parsing an event's body into its
// tree (once per content, inside the ensure command) and rendering that tree
// (on every React render). These benches track both against a synthetic
// thread shaped like a real agent run: mostly short progress lines, a few
// table-heavy reports, one long prose message.
// ---------------------------------------------------------------------------

const context = testContext();

function progressMessage(index: number): string {
  return [
    `Working on step ${String(index)} — **updated** \`module-${String(index)}.ts\`,`,
    `ran \`pnpm check --scope ${String(index)}\` and 校验了输出（第 ${String(index)} 步）。`,
    `See [the diff](https://example.com/diff/${String(index)}) for details.`,
  ].join(" ");
}

function markdownTable(rows: number, columns: number): string {
  const header = `| ${Array.from({ length: columns }, (_, column) => {
    return `Column ${String(column)}`;
  }).join(" | ")} |`;
  const separator = `| ${Array.from({ length: columns }, () => {
    return "---";
  }).join(" | ")} |`;
  const body = Array.from({ length: rows }, (_, row) => {
    return `| ${Array.from({ length: columns }, (_, column) => {
      return `\`r${String(row)}c${String(column)}\``;
    }).join(" | ")} |`;
  });
  return [header, separator, ...body].join("\n");
}

function codeBlock(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => {
    return `const value${String(index)} = compute(${String(index)}, "literal");`;
  }).join("\n");
  return `\`\`\`ts\n${body}\n\`\`\``;
}

function paragraphs(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    return `Paragraph ${String(index)} with **bold**, _italic_, \`code\` and a [link](https://example.com/${String(index)}) plus 一些中文内容（含全角标点）**加粗**后面。`;
  }).join("\n\n");
}

/** ~11 KB, three tables plus prose and code — the report-message shape. */
function reportMessage(): string {
  return [
    "# Run report",
    paragraphs(4),
    markdownTable(20, 6),
    paragraphs(2),
    markdownTable(20, 6),
    codeBlock(30),
    markdownTable(20, 6),
    "> Summary: all checks passed.",
    "- item one\n- item two\n- item three",
  ].join("\n\n");
}

const SHORT_MESSAGE = progressMessage(7);
const REPORT_MESSAGE = reportMessage();
const LONG_PROSE = paragraphs(40);

/** 98 messages: reports at 30/63/97, long prose at 50, progress elsewhere. */
const THREAD: readonly string[] = Array.from({ length: 98 }, (_, index) => {
  if (index === 30 || index === 63 || index === 97) {
    return REPORT_MESSAGE;
  }
  if (index === 50) {
    return LONG_PROSE;
  }
  return progressMessage(index);
});
const THREAD_TAIL = THREAD.slice(-10);

/** What the ensure command does per event: parse + embed prepared signals. */
function prepareTree(source: string): Root {
  const tree = parseMarkdownTree(source, { mathEnabled: true, mermaid: true });
  embedMermaidSignals(tree, (code) => {
    return createMermaidDiagramSignals(code, context.signal);
  });
  embedImageLoadSignals(tree, createImageLoadSignals);
  return tree;
}

function renderTree(tree: Root): void {
  render(
    <StoreProvider value={context.store}>
      <MarkdownEventBody tree={tree} mediaPreview />
    </StoreProvider>,
  );
  cleanup();
}

const CASES: readonly {
  readonly name: string;
  readonly sources: readonly string[];
}[] = [
  {
    name: `report message (${String(REPORT_MESSAGE.length)} chars, tables)`,
    sources: [REPORT_MESSAGE],
  },
  {
    name: `long prose (${String(LONG_PROSE.length)} chars)`,
    sources: [LONG_PROSE],
  },
  {
    name: `short progress message (${String(SHORT_MESSAGE.length)} chars)`,
    sources: [SHORT_MESSAGE],
  },
  {
    name: `thread tail (10 messages)`,
    sources: THREAD_TAIL,
  },
];

describe.each(CASES)("$name", ({ sources }) => {
  const trees = sources.map(prepareTree);
  bench("parse (once per content, ensure command)", () => {
    for (const source of sources) {
      prepareTree(source);
    }
  });
  bench("render from prepared tree (every render)", () => {
    for (const tree of trees) {
      renderTree(tree);
    }
  });
});

describe("thread switch parse volume", () => {
  bench(`full thread (${String(THREAD.length)} messages)`, () => {
    for (const source of THREAD) {
      prepareTree(source);
    }
  });
  bench("visible window only (tail 10 messages)", () => {
    for (const source of THREAD_TAIL) {
      prepareTree(source);
    }
  });
});
