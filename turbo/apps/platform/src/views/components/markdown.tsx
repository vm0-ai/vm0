import MarkdownPreview, {
  type MarkdownPreviewProps,
} from "@uiw/react-markdown-preview";
import { useGet } from "ccstate-react";
import React from "react";
import { theme$ } from "../../signals/theme.ts";

type RewriteArgs = Parameters<
  NonNullable<MarkdownPreviewProps["rehypeRewrite"]>
>;

/**
 * Rewrite callback that:
 * 1. Converts unknown HTML tags to plain text (e.g. <OrganizationSwitcher>)
 * 2. Strips auto-generated heading anchor links whose SVG icons get sanitized
 *    into visible `<svg>` text by rehype-sanitize.
 */
const rehypeRewriteHandler = (() => {
  /** Recursively extract text content from a hast subtree. */
  const collectText = (n: unknown): string => {
    const node = n as { type?: string; value?: string; children?: unknown[] };
    if (node.type === "text" && typeof node.value === "string") {
      return node.value;
    }
    if (Array.isArray(node.children)) {
      return node.children.map(collectText).join("");
    }
    return "";
  };

  const validHtmlTags: ReadonlySet<string> = new Set([
    "a",
    "abbr",
    "address",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "dd",
    "del",
    "details",
    "dfn",
    "dialog",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "i",
    "iframe",
    "img",
    "input",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "main",
    "mark",
    "menu",
    "meter",
    "nav",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "picture",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "section",
    "small",
    "source",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
    "video",
    "wbr",
    // SVG elements (used by code-block copy button icons)
    "svg",
    "path",
    "circle",
    "rect",
    "line",
    "polyline",
    "polygon",
    "g",
  ]);

  return (...args: RewriteArgs) => {
    const [node, , parent] = args;

    // Convert unknown HTML tags to plain text, preserving child content
    if (
      node.type === "element" &&
      !validHtmlTags.has(node.tagName) &&
      parent?.type === "element"
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

    // Strip heading anchor links (`.anchor` class) that contain escaped `<svg>` text.
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
})();

/** Extract headers and row cells from table React children, preserving rich content. */
function extractTableSections(children: React.ReactNode): {
  headers: React.ReactNode[];
  rows: React.ReactNode[][];
} {
  const headers: React.ReactNode[] = [];
  const rows: React.ReactNode[][] = [];

  React.Children.forEach(children, (section) => {
    if (!React.isValidElement(section)) return;
    const el = section as React.ReactElement<{ children?: React.ReactNode }>;

    if (el.type === "thead") {
      React.Children.forEach(el.props.children, (row) => {
        if (!React.isValidElement(row)) return;
        const rowEl = row as React.ReactElement<{
          children?: React.ReactNode;
        }>;
        React.Children.forEach(rowEl.props.children, (th) => {
          if (!React.isValidElement(th)) return;
          headers.push(
            (th as React.ReactElement<{ children?: React.ReactNode }>).props
              .children,
          );
        });
      });
    } else if (el.type === "tbody") {
      React.Children.forEach(el.props.children, (row) => {
        if (!React.isValidElement(row)) return;
        const rowEl = row as React.ReactElement<{
          children?: React.ReactNode;
        }>;
        const cells: React.ReactNode[] = [];
        React.Children.forEach(rowEl.props.children, (td) => {
          if (!React.isValidElement(td)) return;
          cells.push(
            (td as React.ReactElement<{ children?: React.ReactNode }>).props
              .children,
          );
        });
        rows.push(cells);
      });
    }
  });

  return { headers, rows };
}

/**
 * Renders a markdown table as a standard scrollable table on ≥md screens and
 * as a definition list on mobile, controlled by Tailwind responsive classes.
 */
function ResponsiveTable({ children }: { children?: React.ReactNode }) {
  const { headers, rows } = extractTableSections(children);

  return (
    <>
      {/* Desktop: scrollable table wrapper prevents page-level horizontal scroll */}
      <div className="hidden overflow-x-auto md:block">
        <table>{children}</table>
      </div>
      {/* Mobile: definition-list layout */}
      <dl className="divide-border divide-y text-sm md:hidden">
        {rows.map((row, rowIdx) => (
          <div key={rowIdx} className="space-y-2 py-3">
            {row.map((cell, colIdx) => (
              <div key={colIdx} className="grid grid-cols-2 gap-x-3">
                <dt className="text-muted-foreground truncate font-semibold">
                  {headers[colIdx]}
                </dt>
                <dd className="text-foreground">{cell}</dd>
              </div>
            ))}
          </div>
        ))}
      </dl>
    </>
  );
}

export function Markdown({ className, style, ...rest }: MarkdownPreviewProps) {
  const theme = useGet(theme$);
  return (
    <MarkdownPreview
      className={`!bg-transparent !text-foreground text-sm ${className ?? ""}`}
      style={{
        backgroundColor: "transparent",
        fontSize: "0.875rem",
        lineHeight: "1.5",
        fontFamily: "var(--font-family-sans)",
        ...style,
      }}
      wrapperElement={{ "data-color-mode": theme }}
      rehypeRewrite={rehypeRewriteHandler}
      components={
        { table: ResponsiveTable } as MarkdownPreviewProps["components"]
      }
      {...rest}
    />
  );
}
