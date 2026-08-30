import "../css/vendor/uiw-react-markdown-preview-5.2.0.css";
import { CopyButton } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Loader2, Image } from "lucide-react";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import {
  escapeHtmlTags,
  markdownCardKey,
  parseMarkdownTree,
} from "../../lib/markdown/pipeline.ts";
import { openImageLightbox$ } from "../../signals/okou-page/attachment-chips.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { isImageUrl, isSafeMediaUrl, isVideoUrl } from "../../lib/media-url.ts";
import { MarkdownCardView } from "../okou-page/chat-body-cards.tsx";
import { MarkdownFrame } from "./markdown-frame.tsx";
import { MermaidDiagramView } from "./mermaid-diagram.tsx";

type MarkdownNodeProp = { node?: Element };
type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & MarkdownNodeProp;
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & MarkdownNodeProp;
type MarkdownDivProps = ComponentPropsWithoutRef<"div"> & {
  node?: Element;
};

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

function MediaImage({
  src,
  alt,
  load,
}: {
  src: string;
  alt: string;
  load: ImageLoadSignals;
}) {
  const imageStatus = useGet(load.status$);
  const markLoaded = useSet(load.loaded$);
  const markFailed = useSet(load.failed$);
  // Self-sourced lightbox handler so MediaImage doesn't need a callback
  // prop chained from the Markdown caller. Removing the `onImageClick`
  // prop chain is what lets the `components` map and the renderer
  // functions live at module scope with stable identity — which in turn
  // prevents React from tearing down the <video>/<img> subtree on every
  // re-render of the parent and refetching media metadata unnecessarily.
  const openImageLightbox = useSet(openImageLightbox$);
  const showPlaceholder = imageStatus !== "loaded";

  return (
    <button
      type="button"
      onClick={(event) => {
        const threadId = event.currentTarget.closest<HTMLElement>(
          "[data-chat-thread-container-id]",
        )?.dataset.chatThreadContainerId;
        openImageLightbox(threadId ? { threadId, url: src } : src);
      }}
      className="my-1 inline-grid aspect-[10/9] w-[200px] max-w-full cursor-pointer grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] align-top overflow-hidden rounded-lg border border-foreground/10 bg-muted/30"
    >
      {showPlaceholder && (
        <span
          data-testid="markdown-image-preview-loading"
          className="col-start-1 row-start-1 z-10 flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-muted/70 text-muted-foreground"
        >
          {imageStatus === "loading" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Image size={18} />
          )}
        </span>
      )}
      <img
        key={src}
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={markLoaded}
        onError={markFailed}
        className={`col-start-1 row-start-1 block h-full w-full min-h-0 min-w-0 object-contain ${
          showPlaceholder ? "opacity-0" : ""
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
    const load = rest.node?.data?.imageLoadSignals;
    if (load) {
      const alt = typeof children === "string" ? children : "";
      return <MediaImage src={href} alt={alt} load={load} />;
    }
    // A tree parsed during render carries no load signals; the destination
    // stays an ordinary link.
    return (
      <PlainLink href={href} {...rest}>
        {children}
      </PlainLink>
    );
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
  const load = props.node?.data?.imageLoadSignals;
  if (typeof src === "string" && isSafeMediaUrl(src) && load) {
    return <MediaImage src={src} alt={alt ?? ""} load={load} />;
  }
  return <img {...omitMarkdownNodeProp(rest)} src={src} alt={alt} />;
}

// `rehypeMermaid` turns mermaid fences into `<div data-mermaid-code>`; every
// other div renders as-is.
// The pipeline marks copy buttons and mermaid diagrams on the node's `data`,
// which only it can set — `rehype-raw` produces properties, never data — so a
// message quoting the marker markup renders as the plain div it is.
function MarkdownDivRenderer(props: MarkdownDivProps) {
  const { children, ...rest } = props;
  const data = props.node?.data;
  // A card slot enters the tree as a paragraph and leaves it as this div, so it
  // carries the block spacing the paragraph would have had — without it two
  // consecutive cards sit border-to-border.
  if (data?.card) {
    return (
      <div className="zero-markdown-card">
        <MarkdownCardView card={data.card} />
      </div>
    );
  }
  if (typeof data?.copyCode === "string") {
    return (
      <CopyButton
        type="button"
        text={data.copyCode}
        showTooltip={false}
        className="copied"
        data-code={data.copyCode}
      />
    );
  }
  if (data?.mermaidSignals) {
    return <MermaidDiagramView signals={data.mermaidSignals} />;
  }
  return <div {...omitMarkdownNodeProp(rest)}>{children}</div>;
}

const PLAIN_MARKDOWN_COMPONENTS = {
  table: ResponsiveTable,
  a: PlainLinkRenderer,
  img: PlainImageRenderer,
  div: MarkdownDivRenderer,
} as const;

export const MEDIA_MARKDOWN_COMPONENTS = {
  table: ResponsiveTable,
  a: MediaLinkRenderer,
  img: MediaImageRenderer,
  div: MarkdownDivRenderer,
} as const;

// Neutralize raw HTML by escaping only `<`: a tag cannot start without it, so
// escaping `<` alone stops tag injection. Leaving `>` intact preserves Markdown
// block syntax that relies on a leading `>` — most importantly blockquotes,
// which otherwise collapse into a literal `>` paragraph once escaped.
interface MarkdownTreeFrameProps {
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
  readonly tree: Root;
}

function MarkdownTreeFrame({
  className,
  style,
  mediaPreview = false,
  tree,
}: MarkdownTreeFrameProps) {
  return (
    <MarkdownFrame className={className} style={style}>
      {toJsxRuntime(tree, {
        Fragment,
        components: mediaPreview
          ? MEDIA_MARKDOWN_COMPONENTS
          : PLAIN_MARKDOWN_COMPONENTS,
        ignoreInvalidStyle: true,
        jsx,
        jsxs,
        passKeys: true,
        passNode: true,
      })}
    </MarkdownFrame>
  );
}

/**
 * The chat transcript's entry point: renders the tree an event's signal parsed
 * ahead of time, so opening a thread re-renders without re-parsing.
 */
export function MarkdownEventBody({
  tree,
  mediaPreview,
}: {
  readonly tree: Root;
  readonly mediaPreview: boolean;
}) {
  return (
    <MarkdownTreeFrame
      tree={tree}
      mediaPreview={mediaPreview}
      style={{ fontSize: "inherit", lineHeight: "inherit" }}
    />
  );
}

/**
 * Parses on render. For one-off documents outside the chat transcript, where
 * there is no signal to hang the parsed tree off.
 */
export function Markdown({
  className,
  style,
  mediaPreview = false,
  escapeHtml = false,
  source,
}: {
  readonly source: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
  readonly escapeHtml?: boolean;
}) {
  const tree = parseMarkdownTree(
    escapeHtml ? escapeHtmlTags(source) : source,
    {},
  );
  return (
    <MarkdownTreeFrame
      className={className}
      style={style}
      mediaPreview={mediaPreview}
      tree={tree}
    />
  );
}

// The signal layer loads this module as the single rich-content boundary, so
// parsing and rendering arrive together instead of creating a second network
// waterfall after a rich tree has been prepared.
export { markdownCardKey, parseMarkdownTree };
