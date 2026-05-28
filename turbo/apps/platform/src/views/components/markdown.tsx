import MarkdownPreview, {
  type MarkdownPreviewProps,
} from "@uiw/react-markdown-preview";
import { IconLoader2, IconPhoto } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { openImageLightboxOrArtifact$ } from "../../signals/zero-page/zero-artifact-sidebar.ts";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { theme$ } from "../../signals/theme.ts";
import {
  imageLoadStatusByKey$,
  imageLoadStatusRef$,
  setImageLoadStatus$,
} from "../../signals/view-component-state.ts";

type MarkdownNodeProp = { node?: unknown };
type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & MarkdownNodeProp;
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & MarkdownNodeProp;

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

function omitMarkdownNodeProp<Props extends object>(
  props: Props,
): Omit<Props, "node"> {
  const cleanProps = { ...props };
  delete (cleanProps as Partial<MarkdownNodeProp>).node;
  return cleanProps;
}

function PlainLink({ href, children, ...rest }: MarkdownAnchorProps) {
  const linkProps = omitMarkdownNodeProp(rest);
  return (
    <a {...linkProps} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function MediaImage({ src, alt }: { src: string; alt: string }) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  // Self-sourced lightbox handler so MediaImage doesn't need a callback
  // prop chained from the Markdown caller. Removing the `onImageClick`
  // prop chain is what lets the `components` map and the renderer
  // functions live at module scope with stable identity — which in turn
  // prevents React from tearing down the <video>/<img> subtree on every
  // re-render of the parent (the previous behavior caused .mp4 metadata
  // to refetch every time `?artifact=` was toggled).
  const openImageLightbox = useSet(openImageLightboxOrArtifact$);
  const imageLoadKey = `markdown:${src}`;
  const imageStatus = imageLoadStatuses[imageLoadKey] ?? "loading";
  const showPlaceholder = imageStatus !== "loaded";

  return (
    <button
      type="button"
      onClick={() => {
        openImageLightbox(src);
      }}
      className="relative block max-w-full my-1 overflow-hidden rounded-lg border border-foreground/10 cursor-zoom-in"
    >
      {showPlaceholder && (
        <span className="flex h-32 w-48 max-w-full items-center justify-center bg-muted/70 text-muted-foreground">
          {imageStatus === "loading" ? (
            <IconLoader2 size={18} stroke={1.8} className="animate-spin" />
          ) : (
            <IconPhoto size={18} stroke={1.5} />
          )}
        </span>
      )}
      <img
        key={imageLoadKey}
        ref={imageLoadStatusRef}
        src={src}
        alt={alt}
        data-image-load-key={imageLoadKey}
        loading="lazy"
        onLoad={() => {
          setImageLoadStatus(imageLoadKey, "loaded");
        }}
        onError={() => {
          setImageLoadStatus(imageLoadKey, "error");
        }}
        className={`max-h-32 max-w-full object-contain ${
          showPlaceholder ? "absolute inset-0 opacity-0" : ""
        }`}
      />
    </button>
  );
}

function MediaLink({ href, children, ...rest }: MarkdownAnchorProps) {
  if (!href || !isSafeMediaUrl(href)) {
    return (
      <PlainLink href={href} {...rest}>
        {children}
      </PlainLink>
    );
  }

  if (isImageUrl(href)) {
    const alt = typeof children === "string" ? children : "";
    return <MediaImage src={href} alt={alt} />;
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

// Module-scope renderers passed into MarkdownPreview's `components` map.
// Function identity is stable across renders, which keeps MarkdownPreview
// from re-mounting the children at <a>/<img> positions on parent re-render.
function PlainLinkRenderer(
  props: { children?: ReactNode } & MarkdownAnchorProps,
) {
  const { children, ...rest } = props;
  return <PlainLink {...rest}>{children}</PlainLink>;
}

function MediaLinkRenderer(
  props: { children?: ReactNode } & MarkdownAnchorProps,
) {
  const { children, ...rest } = props;
  return <MediaLink {...rest}>{children}</MediaLink>;
}

function PlainImageRenderer(props: MarkdownImageProps) {
  const { src, alt, ...rest } = props;
  return <img {...omitMarkdownNodeProp(rest)} src={src} alt={alt} />;
}

function MediaImageRenderer(props: MarkdownImageProps) {
  const { src, alt, ...rest } = props;
  const hasSafeSrc = typeof src === "string" && isSafeMediaUrl(src);
  if (hasSafeSrc) {
    return <MediaImage src={src} alt={alt ?? ""} />;
  }
  return <img {...omitMarkdownNodeProp(rest)} src={src} alt={alt} />;
}

const PLAIN_MARKDOWN_COMPONENTS = {
  table: ResponsiveTable,
  a: PlainLinkRenderer,
  img: PlainImageRenderer,
} as const;

const MEDIA_MARKDOWN_COMPONENTS = {
  table: ResponsiveTable,
  a: MediaLinkRenderer,
  img: MediaImageRenderer,
} as const;

export function Markdown({
  className,
  style,
  mediaPreview = false,
  mathEnabled = false,
  remarkPlugins,
  rehypePlugins,
  ...rest
}: MarkdownPreviewProps & {
  mediaPreview?: boolean;
  mathEnabled?: boolean;
}) {
  const theme = useGet(theme$);
  const components = mediaPreview
    ? MEDIA_MARKDOWN_COMPONENTS
    : PLAIN_MARKDOWN_COMPONENTS;
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
      remarkPlugins={
        mathEnabled
          ? [
              [remarkMath, { singleDollarTextMath: false }],
              ...(remarkPlugins ?? []),
            ]
          : remarkPlugins
      }
      rehypePlugins={
        mathEnabled ? [rehypeKatex, ...(rehypePlugins ?? [])] : rehypePlugins
      }
      components={components}
      {...rest}
    />
  );
}
