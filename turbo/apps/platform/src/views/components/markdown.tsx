import MarkdownPreview, {
  type MarkdownPreviewProps,
} from "@uiw/react-markdown-preview";

/**
 * Rewrite callback that converts unknown HTML tags to plain text.
 * Agent responses may contain component-like tags (e.g. <OrganizationSwitcher>)
 * that the HTML parser renders as DOM elements, causing React warnings.
 */
function rewriteUnknownTags(
  ...args: Parameters<NonNullable<MarkdownPreviewProps["rehypeRewrite"]>>
) {
  const VALID_HTML_TAGS: ReadonlySet<string> = new Set([
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
  ]);

  const [node, , parent] = args;
  if (
    node.type === "element" &&
    !VALID_HTML_TAGS.has(node.tagName) &&
    parent?.type === "element"
  ) {
    const text = `<${node.tagName}>`;
    Object.assign(node, {
      type: "text",
      value: text,
      tagName: undefined,
      properties: undefined,
      children: undefined,
    });
  }
}

export function Markdown({ className, style, ...rest }: MarkdownPreviewProps) {
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
      rehypeRewrite={rewriteUnknownTags}
      {...rest}
    />
  );
}
