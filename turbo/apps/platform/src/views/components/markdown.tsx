import MarkdownPreview, {
  type MarkdownPreviewProps,
} from "@uiw/react-markdown-preview";
import { useGet } from "ccstate-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
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

/**
 * Wraps a markdown table in an overflow-x-auto container so wide tables scroll
 * within their container instead of stretching the page on mobile.
 */
function ResponsiveTable({ children }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  );
}

function isImageUrl(href: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:\?|#|$)/i.test(href);
}

function isVideoUrl(href: string): boolean {
  return /\.(mp4|webm|mov|ogv)(?:\?|#|$)/i.test(href);
}

/**
 * Only `http:` / `https:` URLs are safe to render as `<img src>` or `<video src>`.
 * Blocks `javascript:`, `data:`, `file:`, etc. in assistant-rendered markdown.
 */
function isSafeMediaUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function PlainLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function MediaImage({
  src,
  alt,
  onImageClick,
}: {
  src: string;
  alt: string;
  onImageClick?: (url: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onImageClick?.(src);
      }}
      className="block max-w-full my-1 rounded-lg overflow-hidden cursor-zoom-in border border-foreground/10"
    >
      <img src={src} alt={alt} className="max-h-32 max-w-full object-contain" />
    </button>
  );
}

function MediaLink({
  href,
  children,
  onImageClick,
  ...rest
}: ComponentPropsWithoutRef<"a"> & {
  onImageClick?: (url: string) => void;
}) {
  if (!href || !isSafeMediaUrl(href)) {
    return (
      <PlainLink href={href} {...rest}>
        {children}
      </PlainLink>
    );
  }

  if (isImageUrl(href)) {
    const alt = typeof children === "string" ? children : "";
    return <MediaImage src={href} alt={alt} onImageClick={onImageClick} />;
  }

  if (isVideoUrl(href)) {
    return (
      <video
        src={href}
        controls
        className="max-h-96 max-w-full my-1 rounded-lg border border-foreground/10"
      />
    );
  }

  return (
    <PlainLink href={href} {...rest}>
      {children}
    </PlainLink>
  );
}

function MarkdownLinkRenderer(
  props: { children?: ReactNode } & ComponentPropsWithoutRef<"a"> & {
      mediaPreview: boolean;
      onImageClick: ((url: string) => void) | undefined;
    },
) {
  const { mediaPreview, onImageClick, children, ...rest } = props;
  if (mediaPreview) {
    return (
      <MediaLink {...rest} onImageClick={onImageClick}>
        {children}
      </MediaLink>
    );
  }
  return <PlainLink {...rest}>{children}</PlainLink>;
}

function MarkdownImageRenderer(
  props: ComponentPropsWithoutRef<"img"> & {
    mediaPreview: boolean;
    onImageClick: ((url: string) => void) | undefined;
  },
) {
  const { mediaPreview, onImageClick, src, alt, ...rest } = props;
  const hasSafeSrc = typeof src === "string" && isSafeMediaUrl(src);
  if (mediaPreview && hasSafeSrc) {
    return <MediaImage src={src} alt={alt ?? ""} onImageClick={onImageClick} />;
  }
  return <img {...rest} src={src} alt={alt} />;
}

export function Markdown({
  className,
  style,
  mediaPreview = false,
  onImageClick,
  ...rest
}: MarkdownPreviewProps & {
  mediaPreview?: boolean;
  onImageClick?: (url: string) => void;
}) {
  const theme = useGet(theme$);
  const renderLink = (
    props: { children?: ReactNode } & ComponentPropsWithoutRef<"a">,
  ) => {
    return (
      <MarkdownLinkRenderer
        {...props}
        mediaPreview={mediaPreview}
        onImageClick={onImageClick}
      />
    );
  };
  const renderImage = (props: ComponentPropsWithoutRef<"img">) => {
    return (
      <MarkdownImageRenderer
        {...props}
        mediaPreview={mediaPreview}
        onImageClick={onImageClick}
      />
    );
  };
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
      components={{
        table: ResponsiveTable,
        a: renderLink,
        img: renderImage,
      }}
      {...rest}
    />
  );
}
