import type { ReactNode } from "react";
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  artifactFullscreen$,
  type ArtifactRef,
  chatArtifactSidebarEnabled$,
  closeArtifact$,
  currentArtifactRef$,
  toggleArtifactFullscreen$,
} from "../../signals/zero-page/zero-artifact-sidebar.ts";
import {
  copyAttachmentLinkToClipboard,
  CsvPreviewTable,
  downloadAttachmentUrl,
  parseCsvRows,
  publicAttachmentUrl,
  TextPreviewLoader,
} from "./zero-attachment-chips.tsx";
import { Markdown } from "../components/markdown.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";

// ---------------------------------------------------------------------------
// ArtifactSidebar — page-level pane for previewing the artifact pointed to
// by ?artifact=. Renders kind-specific bodies inline (no modal), with a
// fullscreen toggle that swaps to a full-viewport layout. Mounted by the
// chat thread page and gated by FeatureSwitchKey.ChatArtifactSidebar.
// ---------------------------------------------------------------------------

export function ArtifactSidebarSlot() {
  const enabled = useGet(chatArtifactSidebarEnabled$);
  const ref = useGet(currentArtifactRef$);

  if (!enabled || !ref) {
    return null;
  }

  return <ArtifactSidebar artifactRef={ref} />;
}

export function ArtifactSidebar({ artifactRef }: { artifactRef: ArtifactRef }) {
  const fullscreen = useGet(artifactFullscreen$);
  const close = useSet(closeArtifact$);
  const toggleFullscreen = useSet(toggleArtifactFullscreen$);
  const pageSignal = useGet(pageSignal$);

  const display = resolveArtifactDisplay(artifactRef);

  if (!display) {
    return (
      <div
        className={
          fullscreen
            ? "fixed inset-0 z-40 flex flex-col bg-background"
            : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background"
        }
        data-testid="artifact-sidebar"
      >
        <ArtifactSidebarHeader
          title="Artifact unavailable"
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
          onClose={close}
        />
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Unsupported artifact reference.
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-40 flex flex-col bg-background"
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background"
      }
      data-testid="artifact-sidebar"
    >
      <ArtifactSidebarHeader
        title={display.filename}
        kind={display.kind}
        url={display.url}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onClose={close}
      />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        <ArtifactBody
          url={display.url}
          kind={display.kind}
          filename={display.filename}
          pageSignal={pageSignal}
        />
      </div>
    </div>
  );
}

interface ArtifactDisplay {
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
}

type ArtifactKindForBody =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "file";

function resolveArtifactDisplay(ref: ArtifactRef): ArtifactDisplay | null {
  if (ref.source !== "url") {
    return null;
  }
  return {
    url: ref.url,
    kind: ref.kind,
    filename: ref.filename,
  };
}

function ArtifactSidebarHeader({
  title,
  kind,
  url,
  fullscreen,
  onToggleFullscreen,
  onClose,
}: {
  title: string;
  kind?: ArtifactKindForBody;
  url?: string;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  const publicUrl = url ? publicAttachmentUrl(url) : undefined;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
      {url ? (
        <button
          type="button"
          onClick={() => {
            detach(
              copyAttachmentLinkToClipboard(url),
              Reason.DomCallback,
              "artifact copy link",
            );
          }}
          aria-label="Copy artifact URL"
          title={publicUrl}
          className="group/copy-url flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconCopy size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {publicUrl}
          </span>
        </button>
      ) : (
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {url && (
          <>
            {kind === "html" ? (
              <a
                href={publicAttachmentUrl(url)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in new tab"
                data-testid="artifact-sidebar-open-external"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <IconExternalLink size={16} />
              </a>
            ) : (
              <button
                type="button"
                onClick={() => {
                  detach(
                    downloadAttachmentUrl(url, undefined, title),
                    Reason.DomCallback,
                    "artifact download",
                  );
                }}
                aria-label="Download"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <IconDownload size={16} />
              </button>
            )}
          </>
        )}
        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          data-testid="artifact-sidebar-fullscreen-toggle"
          className="hidden xl:inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          {fullscreen ? (
            <IconArrowsDiagonalMinimize2 size={16} />
          ) : (
            <IconArrowsDiagonal size={16} />
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close artifact"
          data-testid="artifact-sidebar-close"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconX size={16} />
        </button>
      </div>
    </div>
  );
}

function ArtifactBody({
  url,
  kind,
  filename,
  pageSignal,
}: {
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
  pageSignal: AbortSignal;
}) {
  if (kind === "markdown") {
    return <ArtifactMarkdownBody url={url} signal={pageSignal} />;
  }
  if (kind === "text" || kind === "json") {
    return <ArtifactPlainTextBody url={url} kind={kind} signal={pageSignal} />;
  }
  if (kind === "csv") {
    return <ArtifactCsvBody url={url} signal={pageSignal} />;
  }
  if (kind === "image") {
    return <ArtifactImageBody url={url} filename={filename} />;
  }
  if (kind === "video") {
    return <ArtifactVideoBody url={url} filename={filename} />;
  }
  if (kind === "audio") {
    return <ArtifactAudioBody url={url} filename={filename} />;
  }
  if (kind === "html" || kind === "pdf") {
    return <ArtifactIframeBody url={url} kind={kind} filename={filename} />;
  }
  return <ArtifactGenericBody filename={filename} />;
}

function ArtifactSpinner() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <IconLoader2 size={20} className="animate-spin" />
    </div>
  );
}

function ArtifactBodyError({ message }: { message: string }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function ArtifactMarkdownBody({
  url,
  signal,
}: {
  url: string;
  signal: AbortSignal;
}) {
  return (
    <TextPreviewLoader url={url} signal={signal}>
      {({ status, text }) => {
        if (status === "loading") {
          return <ArtifactSpinner />;
        }
        if (status === "error") {
          return <ArtifactBodyError message="Markdown preview unavailable." />;
        }
        return (
          <div className="h-full overflow-auto p-6">
            <Markdown source={text} />
          </div>
        );
      }}
    </TextPreviewLoader>
  );
}

function ArtifactPlainTextBody({
  kind,
  signal,
  url,
}: {
  kind: "text" | "json";
  signal: AbortSignal;
  url: string;
}) {
  return (
    <TextPreviewLoader url={url} signal={signal}>
      {({ status, text }) => {
        if (status === "loading") {
          return <ArtifactSpinner />;
        }
        if (status === "error") {
          return (
            <ArtifactBodyError
              message={
                kind === "json"
                  ? "JSON preview unavailable."
                  : "Text preview unavailable."
              }
            />
          );
        }
        const formatted = formatBodyText(kind, text);
        return (
          <pre
            className="h-full overflow-auto whitespace-pre-wrap break-words p-6 text-sm text-foreground"
            data-testid={`artifact-sidebar-body-${kind}`}
          >
            {formatted}
          </pre>
        );
      }}
    </TextPreviewLoader>
  );
}

function formatBodyText(kind: "text" | "json", text: string): string {
  if (kind === "json") {
    const parsed = jsonParseOr<unknown>(text, null);
    return parsed === null ? text : JSON.stringify(parsed, null, 2);
  }
  return text;
}

function ArtifactCsvBody({
  url,
  signal,
}: {
  url: string;
  signal: AbortSignal;
}) {
  return (
    <TextPreviewLoader url={url} signal={signal}>
      {({ status, text }) => {
        if (status === "loading") {
          return <ArtifactSpinner />;
        }
        if (status === "error") {
          return <ArtifactBodyError message="CSV preview unavailable." />;
        }
        const rows = parseCsvRows(text);
        if (rows.length === 0) {
          return <ArtifactBodyError message="Empty CSV." />;
        }
        return (
          <div className="h-full overflow-auto p-6">
            <CsvPreviewTable rows={rows} />
          </div>
        );
      }}
    </TextPreviewLoader>
  );
}

function ArtifactImageBody({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-muted/20 p-4">
      <img
        src={url}
        alt={filename}
        className="max-h-full max-w-full object-contain"
        data-testid="artifact-sidebar-body-image"
      />
    </div>
  );
}

function ArtifactVideoBody({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-black/95 p-4">
      <video
        src={publicAttachmentUrl(url)}
        controls
        playsInline
        className="max-h-full max-w-full"
        aria-label={`Video preview for ${filename}`}
        data-testid="artifact-sidebar-body-video"
      />
    </div>
  );
}

function ArtifactAudioBody({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <p className="text-sm text-muted-foreground">{filename}</p>
      <audio
        src={url}
        controls
        preload="metadata"
        className="w-full max-w-md"
        aria-label={`Audio preview for ${filename}`}
        data-testid="artifact-sidebar-body-audio"
      />
    </div>
  );
}

function ArtifactIframeBody({
  url,
  kind,
  filename,
}: {
  url: string;
  kind: "html" | "pdf";
  filename: string;
}) {
  // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail
  // (thumbnails / bookmarks) so the embedded preview shows just the page
  // and toolbar by default. Firefox/PDF.js silently ignores it.
  const src = kind === "pdf" ? `${url}#navpanes=0` : url;
  return (
    <iframe
      src={src}
      title={`${filename} preview`}
      sandbox={kind === "html" ? "allow-scripts" : undefined}
      className="h-full w-full bg-background"
      data-testid={`artifact-sidebar-body-${kind}`}
    />
  );
}

function ArtifactGenericBody({ filename }: { filename: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
      <p className="text-sm">No inline preview available for this file.</p>
      <p className="text-xs">{filename}</p>
    </div>
  );
}
