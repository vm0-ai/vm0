import { fireEvent, render, waitFor } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import { describe, expect, it, vi } from "vitest";

import { createMermaidDiagramRegistry } from "../../../signals/mermaid-diagram.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { Markdown } from "../markdown.tsx";

const context = testContext();

function html(source: string): string {
  const { container } = render(
    <StoreProvider value={context.store}>
      <Markdown source={source} mediaPreview mathEnabled />
    </StoreProvider>,
  );
  return container.innerHTML;
}

function links(source: string): { href: string; text: string }[] {
  const { container } = render(
    <StoreProvider value={context.store}>
      <Markdown source={source} mediaPreview />
    </StoreProvider>,
  );
  return [...container.querySelectorAll("a")].map((anchor) => {
    return {
      href: anchor.getAttribute("href") ?? "",
      text: anchor.textContent ?? "",
    };
  });
}

function table(rows: number, columns: number): string {
  const header = `| ${Array.from({ length: columns }, (_, index) => {
    return `Column ${String(index)}`;
  }).join(" | ")} |`;
  const separator = `| ${Array.from({ length: columns }, () => {
    return "---";
  }).join(" | ")} |`;
  const body = Array.from({ length: rows }, (_, rowIndex) => {
    return `| ${Array.from({ length: columns }, (_, columnIndex) => {
      return `\`r${String(rowIndex)}c${String(columnIndex)}\``;
    }).join(" | ")} |`;
  });
  return [header, separator, ...body].join("\n");
}

const MIXED_SOURCE = [
  "# Heading",
  "",
  "Text with **bold**, `code`, ~~strike~~ and 中文（括号）**加粗**后面。",
  "",
  table(12, 6),
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
  "> quote",
  "",
  "- item 1",
  "- item 2",
  "",
  "$$a^2 + b^2 = c^2$$",
  "",
  "https://example.com/auto-link",
  "",
  "![image](https://example.com/picture.png)",
  "",
  "<span>raw html</span>",
].join("\n");

describe("parse-in-render markdown", () => {
  // Chat surfaces render one parsed tree many times, so rendering must not
  // mutate the tree: repeated renders have to produce byte-identical html.
  it("renders identical html across repeated renders", () => {
    const cold = html(MIXED_SOURCE);
    const repeat = html(MIXED_SOURCE);

    expect(repeat).toBe(cold);
  });

  // Only command-prepared trees turn mermaid fences into diagrams; a surface
  // that parses during render keeps the fence as a highlighted code block.
  it("keeps mermaid fences as code without a preparing command", () => {
    const rendered = html("```mermaid\ngraph TD; A-->B;\n```");

    expect(rendered).toContain("language-mermaid");
    expect(rendered).not.toContain("mermaid-block");
  });

  // A surface's registry is keyed by source, so the same fence shares one
  // entry wherever it appears in that surface and different sources never
  // collide.
  it("keys diagram registration by source", () => {
    const registry = createMermaidDiagramRegistry(context.signal);
    const first = context.store.set(registry.register$, "graph TD; A-->B;");
    const again = context.store.set(registry.register$, "graph TD; A-->B;");
    const other = context.store.set(registry.register$, "graph TD; B-->C;");

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it("keys entries by escapeHtml", () => {
    const source = "<span> 123 </span>";
    const { container: raw } = render(
      <StoreProvider value={context.store}>
        <Markdown source={source} mediaPreview />
      </StoreProvider>,
    );
    const { container: escaped } = render(
      <StoreProvider value={context.store}>
        <Markdown source={source} mediaPreview escapeHtml />
      </StoreProvider>,
    );

    expect(escaped.innerHTML).not.toBe(raw.innerHTML);
    expect(escaped.textContent).toContain("<span> 123 </span>");
  });
});

// GFM scans a bare URL to the next ASCII space and trims only ASCII trailing
// punctuation, so Chinese — which writes `。（）` against the link and leaves no
// space — used to end up with the sentence inside the href.
describe("autolink literals against cjk punctuation", () => {
  it("ends the link at full-width punctuation", () => {
    expect(links("链接：https://example.com/a（draft）后续")).toStrictEqual([
      { href: "https://example.com/a", text: "https://example.com/a" },
    ]);
    expect(links("中文https://example.com/a。下一句")).toStrictEqual([
      { href: "https://example.com/a", text: "https://example.com/a" },
    ]);
    expect(links("www.example.com/a（x）后")).toStrictEqual([
      { href: "http://www.example.com/a", text: "www.example.com/a" },
    ]);
  });

  // The `**` only closes once the link stops swallowing it, so this covers the
  // emphasis and the href in one source.
  it("emphasizes a bolded bare url followed by a full-width period", () => {
    const rendered = html(
      "PR 开好了：**https://example.com/pull/28031**。下一步",
    );

    expect(rendered).toContain(
      '<strong><a href="https://example.com/pull/28031"',
    );
    expect(rendered).toContain("。下一步");
  });

  it("leaves ascii autolinks and email untouched", () => {
    expect(links("see https://example.com/a. end")).toStrictEqual([
      { href: "https://example.com/a", text: "https://example.com/a" },
    ]);
    expect(
      links("read https://en.wikipedia.org/wiki/Ruby_(gem) today"),
    ).toStrictEqual([
      {
        href: "https://en.wikipedia.org/wiki/Ruby_(gem)",
        text: "https://en.wikipedia.org/wiki/Ruby_(gem)",
      },
    ]);
    expect(links("联系 contact@example.org。谢谢")).toStrictEqual([
      { href: "mailto:contact@example.org", text: "contact@example.org" },
    ]);
  });

  // Full-width brackets that really belong to a URL are the cost of the rule
  // above: prose that follows a link with a bracket is the far more common
  // shape, and both cannot win.
  it("stops a full-width bracket inside a url too", () => {
    expect(
      links("https://zh.wikipedia.org/wiki/中文（消歧义）是条目"),
    ).toStrictEqual([
      {
        href: "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87",
        text: "https://zh.wikipedia.org/wiki/中文",
      },
    ]);
  });
});

describe("marker node dispatch", () => {
  it("copies the code and confirms", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => {
      return Promise.resolve();
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const { container } = render(
      <StoreProvider value={context.store}>
        <Markdown source={"```ts\nconst a = 1;\n```"} />
      </StoreProvider>,
    );

    const button = container.querySelector(".copied");
    expect(button).not.toBeNull();
    expect(button).toHaveAttribute("data-code", "const a = 1;\n");

    fireEvent.click(button as Element);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const a = 1;\n");
      expect(button).toHaveAccessibleName("Copied");
    });
  });
  // Markers live on the hast node's `data`, which `rehype-raw` cannot produce.
  // Assistant markdown keeps raw HTML, so even markup that copies the rendered
  // button exactly must stay the plain div it is.
  it("leaves a raw div impersonating the copy button alone", () => {
    const { container } = render(
      <StoreProvider value={context.store}>
        <Markdown
          source={'<div class="copied" data-code="x">hello content</div>'}
          mediaPreview
        />
      </StoreProvider>,
    );

    expect(container.textContent).toContain("hello content");
    expect(container.querySelector(".octicon-copy")).toBeNull();
  });

  it("leaves a raw div impersonating a mermaid diagram alone", () => {
    const { container } = render(
      <StoreProvider value={context.store}>
        <Markdown
          source={
            '<div class="mermaid-block" data-mermaid-code="graph TD; A-->B;" data-mermaid-scope="x">hello content</div>'
          }
          mediaPreview
        />
      </StoreProvider>,
    );

    expect(container.textContent).toContain("hello content");
    expect(container.querySelector("[data-mermaid-status]")).toBeNull();
  });
});
