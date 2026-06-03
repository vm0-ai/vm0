import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  IconArrowLeft,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconCopy,
  IconDownload,
  IconDots,
  IconExternalLink,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
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
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  imageLightboxImageRef$,
  imageLightboxState$,
  zoomImageLightboxIn$,
  zoomImageLightboxOut$,
} from "../../signals/view-component-state.ts";

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

export function ArtifactSidebar({
  artifactRef,
  onBack,
  onClose,
}: {
  artifactRef: ArtifactRef;
  onBack?: () => void;
  onClose?: () => void;
}) {
  const fullscreen = useGet(artifactFullscreen$);
  const close = useSet(closeArtifact$);
  const toggleFullscreen = useSet(toggleArtifactFullscreen$);
  const pageSignal = useGet(pageSignal$);
  const closePreview = onClose ?? close;

  const display = resolveArtifactDisplay(artifactRef);

  if (!display) {
    const sidebar = (
      <div
        className={cn(
          fullscreen
            ? "fixed inset-0 z-[100] flex flex-col bg-background"
            : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background",
          "animate-in fade-in slide-in-from-right-2 duration-200",
        )}
        data-testid="artifact-sidebar"
      >
        <ArtifactSidebarHeader
          title="Artifact unavailable"
          fullscreen={fullscreen}
          onBack={onBack}
          onToggleFullscreen={toggleFullscreen}
          onClose={closePreview}
        />
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Unsupported artifact reference.
        </div>
      </div>
    );
    return fullscreen && typeof document !== "undefined"
      ? createPortal(sidebar, document.body)
      : sidebar;
  }

  const sidebar = (
    <div
      className={cn(
        fullscreen
          ? "fixed inset-0 z-[100] flex flex-col bg-background"
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background",
        "animate-in fade-in slide-in-from-right-2 duration-200",
      )}
      data-testid="artifact-sidebar"
    >
      <ArtifactSidebarHeader
        title={display.filename}
        kind={display.kind}
        url={display.url}
        fullscreen={fullscreen}
        onBack={onBack}
        onToggleFullscreen={toggleFullscreen}
        onClose={closePreview}
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
  return fullscreen && typeof document !== "undefined"
    ? createPortal(sidebar, document.body)
    : sidebar;
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
  onBack,
  onToggleFullscreen,
  onClose,
}: {
  title: string;
  kind?: ArtifactKindForBody;
  url?: string;
  fullscreen: boolean;
  onBack?: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  const compactActions = onBack !== undefined;

  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to all artifacts"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <IconArrowLeft size={16} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
        {kind && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {artifactKindLabel(kind)}
          </div>
        )}
      </div>
      <ArtifactSidebarActions
        compactActions={compactActions}
        fullscreen={fullscreen}
        kind={kind}
        onClose={onClose}
        onToggleFullscreen={onToggleFullscreen}
        title={title}
        url={url}
      />
    </div>
  );
}

function ArtifactSidebarActions({
  compactActions,
  fullscreen,
  kind,
  onClose,
  onToggleFullscreen,
  title,
  url,
}: {
  compactActions: boolean;
  fullscreen: boolean;
  kind?: ArtifactKindForBody;
  onClose: () => void;
  onToggleFullscreen: () => void;
  title: string;
  url?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {url && (
        <>
          <ArtifactPrimaryAction kind={kind} title={title} url={url} />
          {!compactActions && <ArtifactCopyAction url={url} />}
        </>
      )}
      <ArtifactFullscreenAction
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      {compactActions && url ? (
        <ArtifactMoreActions onClose={onClose} url={url} />
      ) : (
        <ArtifactCloseAction onClose={onClose} />
      )}
    </div>
  );
}

function ArtifactPrimaryAction({
  kind,
  title,
  url,
}: {
  kind?: ArtifactKindForBody;
  title: string;
  url: string;
}) {
  if (kind === "html") {
    return (
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
    );
  }

  return (
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
  );
}

function ArtifactCopyAction({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        copyArtifactUrl(url);
      }}
      aria-label="Copy artifact URL"
      title={publicAttachmentUrl(url)}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      <IconCopy size={16} />
    </button>
  );
}

function ArtifactFullscreenAction({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
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
  );
}

function ArtifactMoreActions({
  onClose,
  url,
}: {
  onClose: () => void;
  url: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More artifact actions"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconDots size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            copyArtifactUrl(url);
          }}
        >
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onClose}>Close preview</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactCloseAction({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close artifact"
      data-testid="artifact-sidebar-close"
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      <IconX size={16} />
    </button>
  );
}

function copyArtifactUrl(url: string) {
  detach(
    copyAttachmentLinkToClipboard(url),
    Reason.DomCallback,
    "artifact copy link",
  );
}

function artifactKindLabel(kind: ArtifactKindForBody): string {
  switch (kind) {
    case "markdown": {
      return "Markdown document";
    }
    case "text": {
      return "Text document";
    }
    case "json": {
      return "JSON document";
    }
    case "csv": {
      return "Data table";
    }
    case "html": {
      return "Hosted site";
    }
    case "pdf": {
      return "PDF document";
    }
    case "image": {
      return "Image";
    }
    case "video": {
      return "Video";
    }
    case "audio": {
      return "Audio";
    }
    case "file": {
      return "File";
    }
  }
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
  // The sidebar image preview and the legacy full-screen lightbox are mutually
  // exclusive (chatArtifactSidebar feature switch routes image clicks to one
  // or the other), so the lightbox zoom state is reused here. The `key={url}`
  // on the img remounts it on artifact change, which triggers the onRef
  // reset that wipes any stale zoom level.
  const { zoom } = useGet(imageLightboxState$);
  const setImageRef = useSet(imageLightboxImageRef$);
  const zoomIn = useSet(zoomImageLightboxIn$);
  const zoomOut = useSet(zoomImageLightboxOut$);

  return (
    <div className="relative flex h-full items-center justify-center overflow-auto bg-muted/20 p-4">
      <img
        key={url}
        ref={setImageRef}
        src={url}
        alt={filename}
        style={{ transform: `scale(${String(zoom)})` }}
        className="max-h-full max-w-full object-contain transition-transform duration-150"
        data-testid="artifact-sidebar-body-image"
      />
      <ArtifactImageZoomControls
        zoom={zoom}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
      />
    </div>
  );
}

function ArtifactImageZoomControls({
  zoom,
  zoomIn,
  zoomOut,
}: {
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
}) {
  return (
    <div
      className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg border border-border/70 bg-background/95 px-2.5 py-1.5 text-muted-foreground shadow-sm backdrop-blur-sm"
      data-testid="artifact-sidebar-image-zoom-controls"
    >
      <button
        type="button"
        onClick={zoomOut}
        disabled={zoom <= IMAGE_LIGHTBOX_MIN_ZOOM}
        className="flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="Zoom out"
        title="Zoom out"
        data-testid="artifact-sidebar-image-zoom-out"
      >
        -
      </button>
      <span
        className="min-w-10 text-center text-xs font-medium tabular-nums text-foreground"
        data-testid="artifact-sidebar-image-zoom-level"
      >
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={zoomIn}
        disabled={zoom >= IMAGE_LIGHTBOX_MAX_ZOOM}
        className="flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="Zoom in"
        title="Zoom in"
        data-testid="artifact-sidebar-image-zoom-in"
      >
        +
      </button>
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
