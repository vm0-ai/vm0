import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  IconArrowLeft,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconDots,
  IconExternalLink,
  IconLoader2,
  IconZoomReset,
  IconX,
} from "@tabler/icons-react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
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
  CsvPreviewTable,
  parseCsvRows,
  publicAttachmentUrl,
  TextPreviewLoader,
} from "./zero-attachment-chips.tsx";
import { Markdown } from "../components/markdown.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { jsonParseOr } from "../../signals/utils.ts";
import { resetZoomableImageCanvasZoom$ } from "../../signals/view-component-state.ts";
import {
  ZoomableArtifactImageCanvas,
  type ZoomableImageControls,
  zoomableArtifactImageKey,
} from "./zero-zoomable-image-canvas.tsx";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";
import type { ChatThreadArtifactFile } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ArtifactActionSeparator,
  ArtifactDownloadMenu,
  ArtifactShareButton,
  type ArtifactDownloadSyncTarget,
} from "./zero-artifact-actions.tsx";
import {
  artifactFallbackSubtitle,
  artifactTitleSubtitle,
} from "./zero-artifact-display.ts";

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
  thread,
}: ArtifactSidebarProps) {
  if (thread) {
    return (
      <ArtifactSidebarWithThreadData
        artifactRef={artifactRef}
        onBack={onBack}
        onClose={onClose}
        thread={thread}
      />
    );
  }

  return (
    <ArtifactSidebarContent
      artifactRef={artifactRef}
      onBack={onBack}
      onClose={onClose}
    />
  );
}

type ArtifactSidebarProps = {
  artifactRef: ArtifactRef;
  onBack?: () => void;
  onClose?: () => void;
  thread?: ChatThreadSignals;
};

type ArtifactSidebarItem = {
  runId: string;
  file: ChatThreadArtifactFile;
};

function ArtifactSidebarWithThreadData({
  artifactRef,
  onBack,
  onClose,
  thread,
}: ArtifactSidebarProps & { thread: ChatThreadSignals }) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = useLastResolved(thread.agentId$);
  const reloadArtifacts = useSet(thread.setArtifactsDrawerOpen$);
  const item =
    artifactRef.source === "url" && loadable.state === "hasData"
      ? findArtifactItemForUrl(loadable.data, artifactRef.url)
      : undefined;

  return (
    <ArtifactSidebarContent
      agentId={agentId}
      artifactRef={artifactRef}
      item={item}
      onBack={onBack}
      onClose={onClose}
      onSyncSuccess={() => {
        reloadArtifacts(true);
      }}
      threadId={thread.threadId}
    />
  );
}

function ArtifactSidebarContent({
  agentId,
  artifactRef,
  item,
  onBack,
  onClose,
  onSyncSuccess,
  threadId,
}: {
  agentId?: string | null;
  artifactRef: ArtifactRef;
  item?: ArtifactSidebarItem;
  onBack?: () => void;
  onClose?: () => void;
  onSyncSuccess?: () => void;
  threadId?: string;
}) {
  const fullscreen = useGet(artifactFullscreen$);
  const close = useSet(closeArtifact$);
  const toggleFullscreen = useSet(toggleArtifactFullscreen$);
  const resetZoomableImageCanvasZoom = useSet(resetZoomableImageCanvasZoom$);
  const pageSignal = useGet(pageSignal$);
  const closePreview = onClose ?? close;

  const display = resolveArtifactDisplay(artifactRef, item);
  const syncTarget =
    item && threadId
      ? artifactSidebarSyncTarget({
          agentId,
          item,
          onSyncSuccess:
            onSyncSuccess ??
            (() => {
              return undefined;
            }),
          threadId,
        })
      : undefined;

  if (!display) {
    const sidebar = (
      <div
        className={cn(
          fullscreen
            ? "fixed inset-0 z-[100] flex flex-col bg-background"
            : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background",
          "animate-in fade-in duration-[180ms] ease",
        )}
        data-testid="artifact-sidebar"
      >
        <ArtifactSidebarHeader
          title="Artifact unavailable"
          subtitle="Unavailable"
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

  const toggleFullscreenWithImageReset = () => {
    if (display.kind === "image") {
      resetZoomableImageCanvasZoom(
        zoomableArtifactImageKey(
          "artifact-sidebar",
          display.url,
          fullscreen ? "fullscreen" : "sidebar",
        ),
      );
      resetZoomableImageCanvasZoom(
        zoomableArtifactImageKey(
          "artifact-sidebar",
          display.url,
          fullscreen ? "sidebar" : "fullscreen",
        ),
      );
    }
    toggleFullscreen();
  };

  const sidebar = (
    <div
      className={cn(
        fullscreen
          ? "fixed inset-0 z-[100] flex flex-col bg-background"
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background",
        "animate-in fade-in duration-[180ms] ease",
      )}
      data-testid="artifact-sidebar"
    >
      <ArtifactSidebarHeader
        title={display.filename}
        kind={display.kind}
        subtitle={display.subtitle}
        syncTarget={syncTarget}
        url={display.url}
        fullscreen={fullscreen}
        onBack={onBack}
        onToggleFullscreen={toggleFullscreenWithImageReset}
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
  subtitle: string;
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

function findArtifactItemForUrl(
  runs: { runId: string; files: ChatThreadArtifactFile[] }[],
  url: string,
): ArtifactSidebarItem | undefined {
  for (const run of runs) {
    const file = run.files.find((candidate) => {
      return candidate.url === url;
    });
    if (file) {
      return { runId: run.runId, file };
    }
  }
  return undefined;
}

function artifactSidebarSyncTarget(params: {
  agentId: string | null | undefined;
  item: ArtifactSidebarItem;
  onSyncSuccess: () => void;
  threadId: string;
}): ArtifactDownloadSyncTarget {
  return {
    agentId: params.agentId,
    fileId: params.item.file.id,
    filename: params.item.file.filename,
    onSyncSuccess: params.onSyncSuccess,
    runId: params.item.runId,
    synced: params.item.file.googleDriveSync?.status === "synced",
    threadId: params.threadId,
  };
}

function resolveArtifactDisplay(
  ref: ArtifactRef,
  item?: ArtifactSidebarItem,
): ArtifactDisplay | null {
  if (ref.source !== "url") {
    return null;
  }
  if (item) {
    return {
      url: ref.url,
      kind: ref.kind,
      filename: item.file.filename,
      subtitle: artifactTitleSubtitle(ref.kind, item.file),
    };
  }
  return {
    url: ref.url,
    kind: ref.kind,
    filename: ref.filename,
    subtitle: artifactFallbackSubtitle(ref.kind, ref.filename),
  };
}

function ArtifactSidebarHeader({
  title,
  kind,
  subtitle,
  syncTarget,
  url,
  fullscreen,
  onBack,
  onToggleFullscreen,
  onClose,
}: {
  title: string;
  kind?: ArtifactKindForBody;
  subtitle: string;
  syncTarget?: ArtifactDownloadSyncTarget;
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
        {subtitle && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {subtitle}
          </div>
        )}
      </div>
      <ArtifactSidebarActions
        compactActions={compactActions}
        fullscreen={fullscreen}
        kind={kind}
        onClose={onClose}
        onToggleFullscreen={onToggleFullscreen}
        syncTarget={syncTarget}
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
  syncTarget,
  title,
  url,
}: {
  compactActions: boolean;
  fullscreen: boolean;
  kind?: ArtifactKindForBody;
  onClose: () => void;
  onToggleFullscreen: () => void;
  syncTarget?: ArtifactDownloadSyncTarget;
  title: string;
  url?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {url && (
        <>
          {kind === "html" && <ArtifactOpenExternalAction url={url} />}
          <ArtifactShareButton ariaLabel="Share artifact" url={url} />
          <ArtifactDownloadMenu
            ariaLabel="Download artifact"
            filename={title}
            syncTarget={syncTarget}
            url={url}
          />
          <ArtifactActionSeparator />
        </>
      )}
      <ArtifactFullscreenAction
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      {compactActions ? (
        <ArtifactMoreActions onClose={onClose} />
      ) : (
        <ArtifactCloseAction onClose={onClose} />
      )}
    </div>
  );
}

function ArtifactOpenExternalAction({ url }: { url: string }) {
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

function ArtifactMoreActions({ onClose }: { onClose: () => void }) {
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

function ArtifactStageShell({
  centered = false,
  children,
  flush = false,
  gap = false,
  scrollable = true,
}: {
  centered?: boolean;
  children: ReactNode;
  flush?: boolean;
  gap?: boolean;
  scrollable?: boolean;
}) {
  return (
    <div
      className={cn(
        "h-full min-h-0 bg-muted/30",
        flush ? "p-0" : "p-5",
        scrollable ? "overflow-auto" : "overflow-hidden",
      )}
      data-testid="artifact-sidebar-stage"
    >
      <div
        className={cn(
          "mx-auto flex w-full flex-col",
          flush ? "max-w-none" : "max-w-[900px]",
          scrollable ? "min-h-full" : "h-full min-h-0",
          centered && "items-center justify-center",
          gap && "gap-3",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function ArtifactStageCard({
  children,
  fillHeight = false,
}: {
  children: ReactNode;
  fillHeight?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-1 flex-col overflow-hidden",
        fillHeight
          ? "h-full min-h-0 bg-transparent"
          : "min-h-[420px] rounded-xl border border-border/70 bg-background shadow-sm",
      )}
    >
      {children}
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
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactSpinner />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        if (status === "error") {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactBodyError message="Markdown preview unavailable." />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        return (
          <ArtifactStageShell>
            <ArtifactStageCard>
              <div className="h-full overflow-auto p-6">
                <Markdown source={text} />
              </div>
            </ArtifactStageCard>
          </ArtifactStageShell>
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
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactSpinner />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        if (status === "error") {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactBodyError
                  message={
                    kind === "json"
                      ? "JSON preview unavailable."
                      : "Text preview unavailable."
                  }
                />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        const formatted = formatBodyText(kind, text);
        return (
          <ArtifactStageShell>
            <ArtifactStageCard>
              <pre
                className="m-0 h-full overflow-auto whitespace-pre-wrap break-words p-6 text-sm text-foreground"
                data-testid={`artifact-sidebar-body-${kind}`}
              >
                {formatted}
              </pre>
            </ArtifactStageCard>
          </ArtifactStageShell>
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
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactSpinner />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        if (status === "error") {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactBodyError message="CSV preview unavailable." />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        const rows = parseCsvRows(text);
        if (rows.length === 0) {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactBodyError message="Empty CSV." />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        return (
          <ArtifactStageShell>
            <ArtifactStageCard>
              <div className="h-full overflow-auto p-5">
                <CsvPreviewTable rows={rows} />
              </div>
            </ArtifactStageCard>
          </ArtifactStageShell>
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
  const fullscreen = useGet(artifactFullscreen$);

  return (
    <ArtifactStageShell flush scrollable={false}>
      <ArtifactStageCard fillHeight>
        <ZoomableArtifactImageCanvas
          src={publicAttachmentUrl(url)}
          alt={filename}
          zoomKey={zoomableArtifactImageKey(
            "artifact-sidebar",
            url,
            fullscreen ? "fullscreen" : "sidebar",
          )}
          imageTestId="artifact-sidebar-body-image"
          contentClassName="p-6"
        >
          {(controls) => {
            return <ArtifactImageZoomControls controls={controls} />;
          }}
        </ZoomableArtifactImageCanvas>
      </ArtifactStageCard>
    </ArtifactStageShell>
  );
}

function ArtifactImageZoomControls({
  controls,
}: {
  controls: ZoomableImageControls;
}) {
  return (
    <div
      className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg bg-background/95 px-2.5 py-1.5 text-muted-foreground shadow-sm backdrop-blur-sm"
      data-testid="artifact-sidebar-image-zoom-controls"
    >
      <button
        type="button"
        onClick={controls.zoomOut}
        disabled={!controls.canZoomOut}
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
        {Math.round(controls.zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={controls.zoomIn}
        disabled={!controls.canZoomIn}
        className="flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="Zoom in"
        title="Zoom in"
        data-testid="artifact-sidebar-image-zoom-in"
      >
        +
      </button>
      <button
        type="button"
        onClick={controls.resetZoom}
        className="flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-muted/70 hover:text-foreground"
        aria-label="Reset zoom"
        title="Reset zoom"
        data-testid="artifact-sidebar-image-reset-zoom"
      >
        <IconZoomReset size={15} stroke={1.8} />
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
    <ArtifactStageShell centered>
      <div
        className="w-full overflow-hidden rounded-xl border border-border/70 bg-black shadow-sm"
        data-testid="artifact-sidebar-video-stage"
      >
        <video
          src={publicAttachmentUrl(url)}
          controls
          playsInline
          className="block aspect-video w-full bg-black object-contain"
          aria-label={`Video preview for ${filename}`}
          data-testid="artifact-sidebar-body-video"
        />
      </div>
    </ArtifactStageShell>
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
    <ArtifactStageShell centered>
      <div className="flex w-full max-w-[520px] flex-col items-center gap-4 rounded-xl border border-border/70 bg-background p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">{filename}</p>
        <audio
          src={publicAttachmentUrl(url)}
          controls
          preload="metadata"
          className="w-full"
          aria-label={`Audio preview for ${filename}`}
          data-testid="artifact-sidebar-body-audio"
        />
      </div>
    </ArtifactStageShell>
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
  if (kind === "html") {
    return (
      <iframe
        src={src}
        title={`${filename} preview`}
        sandbox="allow-scripts"
        className="h-full w-full border-0 bg-background"
        data-testid={`artifact-sidebar-body-${kind}`}
      />
    );
  }

  return (
    <ArtifactStageShell>
      <div className="flex min-h-[420px] w-full flex-1 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
        <iframe
          src={src}
          title={`${filename} preview`}
          className="h-full w-full bg-background"
          data-testid={`artifact-sidebar-body-${kind}`}
        />
      </div>
    </ArtifactStageShell>
  );
}

function ArtifactGenericBody({ filename }: { filename: string }) {
  return (
    <ArtifactStageShell centered>
      <div className="flex w-full max-w-md flex-col items-center justify-center gap-3 rounded-xl border border-border/70 bg-background p-6 text-center text-muted-foreground shadow-sm">
        <p className="text-sm">No inline preview available for this file.</p>
        <p className="text-xs">{filename}</p>
      </div>
    </ArtifactStageShell>
  );
}
