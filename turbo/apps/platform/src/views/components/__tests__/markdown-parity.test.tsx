import MarkdownPreview from "@uiw/react-markdown-preview/common";
import { render } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import rehypeKatex from "rehype-katex";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { Markdown, MEDIA_MARKDOWN_COMPONENTS } from "../rich-markdown.tsx";

type RewriteArgs = Parameters<
  NonNullable<React.ComponentProps<typeof MarkdownPreview>["rehypeRewrite"]>
>;

const VALID_HTML_TAGS: ReadonlySet<string> = new Set(
  "a abbr address area article aside audio b bdi bdo blockquote br caption cite code col colgroup data dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i iframe img input ins kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section small source span strong sub summary sup table tbody td template textarea tfoot th thead time tr u ul var video wbr svg path circle rect line polyline polygon g".split(
    " ",
  ),
);

const collectText = (input: unknown): string => {
  const node = input as { type?: string; value?: string; children?: unknown[] };
  if (node.type === "text" && typeof node.value === "string") {
    return node.value;
  }
  if (Array.isArray(node.children)) {
    return node.children.map(collectText).join("");
  }
  return "";
};

/** The `rehypeRewrite` prop the component passed before the pipeline move. */
const legacyRehypeRewriteHandler = (...args: RewriteArgs) => {
  const [node, , parent] = args;
  if (
    node.type === "element" &&
    !VALID_HTML_TAGS.has(node.tagName) &&
    (parent?.type === "element" || parent?.type === "root")
  ) {
    const inner = collectText(node);
    const text = inner
      ? `<${node.tagName}>${inner}</${node.tagName}>`
      : `<${node.tagName}>`;
    Object.assign(node, {
      type: "text",
      value: text,
      tagName: undefined,
      properties: undefined,
      children: undefined,
    });
    return;
  }
  if (
    node.type === "element" &&
    node.tagName === "a" &&
    node.properties?.class === "anchor"
  ) {
    Object.assign(node, {
      type: "text",
      value: "",
      tagName: undefined,
      properties: undefined,
      children: undefined,
    });
  }
};

const context = testContext();

function htmlWithoutCopyControls(container: HTMLElement): string {
  // Copy controls intentionally come from different component owners during
  // the pipeline migration. Their behavior is covered by the Markdown and UI
  // CopyButton tests; this guard compares the rendered Markdown content.
  for (const control of container.querySelectorAll<HTMLElement>(
    ".copied[data-code]",
  )) {
    control.remove();
  }
  return container.innerHTML;
}

/**
 * Temporary guard for the move off `react-markdown`: renders the same source
 * through the old `<MarkdownPreview />` configuration and through the new
 * pipeline, and requires byte-identical DOM. Delete together with the
 * `@uiw/react-markdown-preview` component dependency once this has shipped.
 */
function legacyHtml(source: string): string {
  const { container } = render(
    <StoreProvider value={context.store}>
      <MarkdownPreview
        className="min-w-0 max-w-full !bg-transparent !text-foreground text-sm"
        style={{
          backgroundColor: "transparent",
          fontSize: "0.875rem",
          lineHeight: "1.5",
          fontFamily: "var(--font-family-sans)",
        }}
        wrapperElement={{ "data-color-mode": "light" }}
        rehypeRewrite={legacyRehypeRewriteHandler}
        pluginsFilter={(type, plugins) => {
          if (type !== "remark") {
            return plugins;
          }
          return [
            ...plugins.filter((plugin) => {
              return plugin !== remarkCjkFriendlyStrikethrough;
            }),
            remarkCjkFriendlyStrikethrough,
          ];
        }}
        remarkPlugins={[
          [remarkMath, { singleDollarTextMath: false }],
          remarkCjkFriendly,
          remarkCjkFriendlyStrikethrough,
        ]}
        rehypePlugins={[rehypeKatex]}
        components={MEDIA_MARKDOWN_COMPONENTS}
        source={source}
      />
    </StoreProvider>,
  );
  return htmlWithoutCopyControls(container);
}

function currentHtml(source: string): string {
  const { container } = render(
    <StoreProvider value={context.store}>
      <Markdown source={source} mediaPreview mathEnabled />
    </StoreProvider>,
  );
  return htmlWithoutCopyControls(container);
}

const CASES: Readonly<Record<string, string>> = {
  headings: "# One\n\n## Two\n\n### Three with `code`",
  emphasis:
    "Text with **bold**, _italic_, `code`, ~~strike~~ and 中文（括号）**加粗**后面。",
  cjkStrikethrough: "中文~~删除线~~后面 and ~~ascii~~ too",
  table: [
    "| Column A | Column B | Column C |",
    "| --- | ---: | :--- |",
    "| `r0c0` | plain | **bold** |",
    "| `r1c0` | 中文 | [link](https://example.com) |",
  ].join("\n"),
  fencedCode: "```ts\nconst value: number = 1;\nconsole.log(value);\n```",
  fencedCodeUnknownLanguage: "```wat\nnot a real language\n```",
  fencedCodeMeta: "```js showLineNumbers\nconst a = 1;\n```",
  // Standalone surfaces render mermaid fences as plain code blocks; only
  // command-prepared trees (chat, shared threads) turn them into diagrams.
  mermaid: "```mermaid\ngraph TD; A-->B;\n```",
  mermaidUnclosed: "```mermaid\ngraph TD; A-->B;",
  blockquote: "> quoted passage\n>\n> second line",
  alert: "> [!NOTE]\n> An alert body",
  lists: "- one\n- two\n  - nested\n\n1. first\n2. second",
  taskList: "- [ ] todo\n- [x] done",
  math: "$$a^2 + b^2 = c^2$$",
  autolink: "See https://example.com/auto-link for details",
  image: "![alt text](https://example.com/picture.png)",
  imageUnsafe: "![alt text](file:///etc/passwd)",
  videoLink: "[clip](https://example.com/clip.mp4)",
  rawHtml:
    "<span>raw html</span> and <OrganizationSwitcher>unknown</OrganizationSwitcher>",
  htmlComment: "before\n\n<!-- a comment -->\n\nafter",
  horizontalRule: "above\n\n---\n\nbelow",
  footnoteStyleLink: "[ref]: https://example.com\n\nSee [ref].",
  emptySource: "",
};

describe("markdown pipeline parity with react-markdown", () => {
  it.each(Object.entries(CASES))("renders %s identically", (_name, source) => {
    expect(currentHtml(source)).toBe(legacyHtml(source));
  });
});
