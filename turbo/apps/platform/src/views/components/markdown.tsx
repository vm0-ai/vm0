import type { Root } from "hast";
import type { CSSProperties } from "react";

import { i18n } from "../../i18n/index.ts";
import {
  createPlainMarkdownTree,
  plainTextFromMarkdownTree,
} from "../../lib/markdown/plain-markdown.ts";
import { MarkdownTextWithColorPreviews } from "./markdown-color-preview.tsx";
import { MarkdownFrame } from "./markdown-frame.tsx";
import {
  Markdown as RichMarkdown,
  MarkdownEventBody as RichMarkdownEventBody,
} from "./rich-markdown.tsx";

interface MarkdownProps {
  readonly source: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly mediaPreview?: boolean;
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
      {text === "" ? null : (
        <p className="m-0">
          <MarkdownTextWithColorPreviews text={text} />
        </p>
      )}
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

function RichContentError({
  onRetry,
  style,
}: {
  readonly onRetry: () => void;
  readonly style?: CSSProperties;
}) {
  return (
    <MarkdownFrame style={style}>
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        onClick={onRetry}
      >
        {i18n.t(($) => {
          return $.chat.errors.recovery.tryAgain;
        })}
      </button>
    </MarkdownFrame>
  );
}

/** Renders prepared plain trees immediately and rich trees synchronously. */
export function MarkdownEventBody({
  onRetry,
  tree,
  mediaPreview,
}: {
  readonly onRetry?: () => void;
  readonly tree: Root | undefined;
  readonly mediaPreview: boolean;
}) {
  if (tree === undefined) {
    if (onRetry !== undefined) {
      return (
        <RichContentError
          onRetry={onRetry}
          style={{ fontSize: "inherit", lineHeight: "inherit" }}
        />
      );
    }
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
  return <RichMarkdownEventBody tree={tree} mediaPreview={mediaPreview} />;
}

/** One-off Markdown entry point. */
export function Markdown({
  mediaPreview = false,
  escapeHtml = false,
  ...props
}: MarkdownProps) {
  const tree = createPlainMarkdownTree(props.source, { mathEnabled: false });
  if (tree !== null && !escapeHtml) {
    return (
      <PlainMarkdown
        text={plainTextFromMarkdownTree(tree) ?? ""}
        className={props.className}
        style={props.style}
      />
    );
  }
  return (
    <RichMarkdown
      {...props}
      mediaPreview={mediaPreview}
      escapeHtml={escapeHtml}
    />
  );
}
