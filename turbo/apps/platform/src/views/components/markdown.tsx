import "@uiw/react-markdown-preview/markdown.css";
import { useGet, useSet } from "ccstate-react";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Loader2, Image } from "lucide-react";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import {
  escapeHtmlTags,
  parseMarkdownTree,
} from "../../lib/markdown/pipeline.ts";
import {
  copiedMarkdownCode$,
  copyMarkdownCode$,
} from "../../signals/markdown-copy.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { openImageLightbox$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import { theme$ } from "../../signals/theme.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { isImageUrl, isSafeMediaUrl, isVideoUrl } from "../../lib/media-url.ts";
import { MarkdownCardView } from "../zero-page/chat-body-cards.tsx";
import { MermaidDiagramView } from "./mermaid-diagram.tsx";
import { cn } from "@vm0/ui";

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
      className="relative my-1 inline-flex aspect-[10/9] w-[200px] max-w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-foreground/10 bg-muted/30"
    >
      {/* Preserve one flex item so the inline baseline cannot change on load. */}
      <span aria-hidden="true" className="block h-full w-full" />
      {showPlaceholder && (
        <span
          data-testid="markdown-image-preview-loading"
          className="absolute inset-0 flex h-full w-full items-center justify-center bg-muted/70 text-muted-foreground"
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
        className={`absolute inset-0 h-full w-full object-contain ${
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

// The markup below is what `@uiw/react-markdown-preview` used to emit, kept so
// the existing `.copied` styles still apply.
function CodeCopyButton({ code }: { code: string }) {
  const copied = useGet(copiedMarkdownCode$).has(code);
  const copyCode = useSet(copyMarkdownCode$);

  return (
    <div
      className={copied ? "copied active" : "copied"}
      data-code={code}
      onClick={() => {
        detach(copyCode(code), Reason.DomCallback);
      }}
    >
      <svg
        className="octicon-copy"
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="currentColor"
        height={12}
        width={12}
      >
        <path
          fillRule="evenodd"
          d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"
        />
        <path
          fillRule="evenodd"
          d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"
        />
      </svg>
      <svg
        className="octicon-check"
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="currentColor"
        height={12}
        width={12}
      >
        <path
          fillRule="evenodd"
          d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"
        />
      </svg>
    </div>
  );
}

// `rehypeMermaid` turns mermaid fences into `<div data-mermaid-code>`; every
// other div renders as-is.
// The pipeline marks copy buttons and mermaid diagrams on the node's `data`,
// which only it can set — `rehype-raw` produces properties, never data — so a
// message quoting the marker markup renders as the plain div it is.
function MarkdownDivRenderer(props: MarkdownDivProps) {
  const { children, ...rest } = props;
  const data = props.node?.data;
  if (data?.card) {
    return <MarkdownCardView card={data.card} />;
  }
  if (typeof data?.copyCode === "string") {
    return <CodeCopyButton code={data.copyCode} />;
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
interface MarkdownFrameProps {
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
  readonly tree: Root;
}

function MarkdownFrame({
  className,
  style,
  mediaPreview = false,
  tree,
}: MarkdownFrameProps) {
  const theme = useGet(theme$);

  return (
    <div
      data-color-mode={theme}
      className={cn(
        "wmde-markdown wmde-markdown-color",
        "min-w-0 max-w-full !bg-transparent !text-foreground text-sm",
        className,
      )}
      style={{
        backgroundColor: "transparent",
        fontSize: "0.875rem",
        lineHeight: "1.5",
        fontFamily: "var(--font-family-sans)",
        ...style,
      }}
    >
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
    </div>
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
    <MarkdownFrame
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
  mathEnabled = false,
  escapeHtml = false,
  source,
}: {
  readonly source: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
  readonly mathEnabled?: boolean;
  readonly escapeHtml?: boolean;
}) {
  const tree = parseMarkdownTree(escapeHtml ? escapeHtmlTags(source) : source, {
    mathEnabled,
  });
  return (
    <MarkdownFrame
      className={className}
      style={style}
      mediaPreview={mediaPreview}
      tree={tree}
    />
  );
}
