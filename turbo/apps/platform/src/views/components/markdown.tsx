import type { Root } from "hast";
import { useLoadable } from "ccstate-react";
import type { CSSProperties } from "react";

import {
  createPlainMarkdownTree,
  plainTextFromMarkdownTree,
} from "../../lib/markdown/plain-markdown.ts";
import { MarkdownFrame } from "./markdown-frame.tsx";
import {
  getLoadedRichMarkdown,
  richMarkdownModule$,
} from "../../signals/rich-markdown-module.ts";

interface MarkdownProps {
  readonly source: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
  readonly mathEnabled?: boolean;
  readonly escapeHtml?: boolean;
}

function PlainMarkdown({
  text,
  className,
  style,
}: {
  readonly text: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <MarkdownFrame className={className} style={style}>
      {text === "" ? null : <p className="m-0">{text}</p>}
    </MarkdownFrame>
  );
}

function RichContentLoading({
  className,
  style,
}: {
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <MarkdownFrame className={className} style={style}>
      <span
        aria-hidden="true"
        data-testid="rich-content-loading"
        className="block h-5 w-24 max-w-full animate-pulse rounded bg-muted/60"
      />
    </MarkdownFrame>
  );
}

function LoadedMarkdownEventBody({
  tree,
  mediaPreview,
}: {
  readonly tree: Root;
  readonly mediaPreview: boolean;
}) {
  const loadable = useLoadable(richMarkdownModule$);
  const module =
    getLoadedRichMarkdown() ??
    (loadable.state === "hasData" ? loadable.data : undefined);
  if (module !== undefined) {
    return <module.MarkdownEventBody tree={tree} mediaPreview={mediaPreview} />;
  }
  if (loadable.state === "hasError") {
    throw loadable.error;
  }
  return (
    <RichContentLoading
      style={{ fontSize: "inherit", lineHeight: "inherit" }}
    />
  );
}

/** Renders prepared plain trees immediately and suspends only a rich body. */
export function MarkdownEventBody({
  tree,
  mediaPreview,
}: {
  readonly tree: Root | undefined;
  readonly mediaPreview: boolean;
}) {
  if (tree === undefined) {
    return (
      <RichContentLoading
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    );
  }
  const plainText = plainTextFromMarkdownTree(tree);
  if (plainText !== null) {
    return (
      <PlainMarkdown
        text={plainText}
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    );
  }
  return <LoadedMarkdownEventBody tree={tree} mediaPreview={mediaPreview} />;
}

function LoadedMarkdown(props: MarkdownProps) {
  const loadable = useLoadable(richMarkdownModule$);
  const module =
    getLoadedRichMarkdown() ??
    (loadable.state === "hasData" ? loadable.data : undefined);
  if (module !== undefined) {
    return <module.Markdown {...props} />;
  }
  if (loadable.state === "hasError") {
    throw loadable.error;
  }
  return <RichContentLoading className={props.className} style={props.style} />;
}

/**
 * One-off Markdown entry point. Syntax-free text stays synchronous; the local
 * Markdown surface owns the loading state for every richer document.
 */
export function Markdown({
  mediaPreview = false,
  mathEnabled = false,
  escapeHtml = false,
  ...props
}: MarkdownProps) {
  const tree = createPlainMarkdownTree(props.source, { mathEnabled });
  if (tree !== null && !escapeHtml) {
    return (
      <PlainMarkdown
        text={plainTextFromMarkdownTree(tree) ?? ""}
        className={props.className}
        style={props.style}
      />
    );
  }
  const richProps = { mediaPreview, mathEnabled, escapeHtml, ...props };
  return <LoadedMarkdown {...richProps} />;
}
