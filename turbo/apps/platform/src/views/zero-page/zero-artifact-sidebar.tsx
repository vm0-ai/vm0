import type { ReactNode } from "react";
import {
  IconArrowLeft,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconChevronLeft,
  IconChevronRight,
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
import type { ArtifactRef } from "../../signals/chat-page/thread-sidebar.ts";
import {
  CsvPreviewTable,
  parseCsvRows,
  publicAttachmentUrl,
  TextPreviewLoader,
} from "./zero-attachment-chips.tsx";
import { artifactPreviewUrlsMatch } from "./zero-attachment-url.ts";
import { lightboxDialogVisible$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import { Markdown } from "../components/markdown.tsx";
import { jsonParseOr } from "../../signals/utils.ts";
import type { TextPreviewComputed } from "../../signals/text-preview.ts";
import { resetZoomableImageCanvasZoom$ } from "../../signals/view-component-state.ts";
import {
  ZoomableArtifactImageCanvas,
  type ZoomableImageControls,
  zoomableArtifactImageKey,
} from "./zero-zoomable-image-canvas.tsx";
import type { ChatThreadSignals } from "../../signals/chat-page/chat-thread-signals.ts";
import type { ChatThreadArtifactFile } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ArtifactActionSeparator,
  ArtifactActionTooltip,
  ArtifactDownloadMenu,
  ArtifactShareButton,
  type ArtifactDownloadSyncTarget,
} from "./zero-artifact-actions.tsx";
import {
  artifactFallbackSubtitle,
  artifactTitleSubtitle,
} from "./zero-artifact-display.ts";
import {
  currentMessageImageArtifactNavigation,
  equalMessageImageGroups,
  type ImageArtifactNavigationItem,
  shouldIgnoreImageArtifactNavigationKey,
} from "./zero-artifact-image-navigation.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";

// ---------------------------------------------------------------------------
// ArtifactSidebar — thread-owned pane for rendering kind-specific artifact
// previews inline, with a fullscreen toggle that swaps to a full-viewport
// layout.
// ---------------------------------------------------------------------------

const ARTIFACT_FULLSCREEN_SHELL_CLASSNAME =
  "fixed inset-0 flex min-h-0 flex-col bg-background pt-[var(--sat)] pb-[var(--sab)]";
const ARTIFACT_FULLSCREEN_DEFAULT_LAYER_CLASSNAME = "z-[100]";

export function ArtifactSidebar({
  artifactRef,
  fullscreenState,
  onBack,
  onClose,
  onNavigateImage,
  text$,
  thread,
}: ArtifactSidebarProps) {
  return (
    <ArtifactSidebarWithThreadContext
      artifactRef={artifactRef}
      fullscreenState={fullscreenState}
      onBack={onBack}
      onClose={onClose}
      onNavigateImage={onNavigateImage}
      text$={text$}
      thread={thread}
    />
  );
}

type ArtifactSidebarFullscreenState = {
  readonly active: boolean;
  readonly toggle: () => void;
};

type ArtifactSidebarProps = {
  readonly artifactRef: ArtifactRef;
  readonly fullscreenState: ArtifactSidebarFullscreenState;
  readonly onBack?: () => void;
  readonly onClose: () => void;
  readonly onNavigateImage: (url: string) => void;
  readonly text$?: TextPreviewComputed;
  readonly thread: ChatThreadSignals;
};

type ArtifactSidebarItem = {
  runId: string;
  file: ChatThreadArtifactFile;
};

type ArtifactImageNavigationActions = {
  readonly onNext?: () => void;
  readonly onPrevious?: () => void;
};

type ArtifactSidebarContentProps = {
  agentId?: string | null;
  artifactRef: ArtifactRef;
  fullscreenState: ArtifactSidebarFullscreenState;
  imageNavigation?: ArtifactImageNavigationActions;
  item?: ArtifactSidebarItem;
  onBack?: () => void;
  onClose: () => void;
  onSyncSuccess?: () => void;
  text$?: TextPreviewComputed;
  threadId?: string;
};

function ArtifactSidebarWithThreadContext({
  artifactRef,
  fullscreenState,
  onBack,
  onClose,
  onNavigateImage,
  text$: providedText$,
  thread,
}: ArtifactSidebarProps) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = useGet(thread.agentId$);
  const messageGroups = useLastResolved(thread.messageImageGroups$, {
    equalityFn: equalMessageImageGroups,
  });
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const text$ =
    providedText$ ??
    (artifactRef.source === "url"
      ? thread.artifactSignalsForUrl(artifactRef.url)?.text$
      : undefined);
  const item =
    artifactRef.source === "url" && loadable.state === "hasData"
      ? findArtifactItemForUrl(loadable.data, artifactRef.url)
      : undefined;
  const imageNavigation =
    artifactRef.source === "url" && loadable.state === "hasData"
      ? currentMessageImageArtifactNavigation(
          loadable.data,
          messageGroups ?? [],
          artifactRef.url,
        )
      : {};
  const imageNavigationAction = (
    navigationItem: ImageArtifactNavigationItem | undefined,
  ) => {
    if (!navigationItem) {
      return undefined;
    }
    return () => {
      onNavigateImage(navigationItem.url);
    };
  };

  return (
    <ArtifactSidebarContent
      agentId={agentId}
      artifactRef={artifactRef}
      fullscreenState={fullscreenState}
      imageNavigation={{
        onNext: imageNavigationAction(imageNavigation.next),
        onPrevious: imageNavigationAction(imageNavigation.previous),
      }}
      item={item}
      onBack={onBack}
      onClose={onClose}
      onSyncSuccess={() => {
        reloadArtifacts();
      }}
      text$={text$}
      threadId={thread.threadId}
    />
  );
}

function noop() {
  return undefined;
}

function artifactSidebarSyncTargetForItem({
  agentId,
  item,
  onSyncSuccess,
  threadId,
}: {
  agentId?: string | null;
  item?: ArtifactSidebarItem;
  onSyncSuccess?: () => void;
  threadId?: string;
}): ArtifactDownloadSyncTarget | undefined {
  return item && threadId
    ? artifactSidebarSyncTarget({
        agentId,
        item,
        onSyncSuccess: onSyncSuccess ?? noop,
        threadId,
      })
    : undefined;
}

function ArtifactSidebarContent({
  agentId,
  artifactRef,
  fullscreenState,
  imageNavigation,
  item,
  onBack,
  onClose,
  onSyncSuccess,
  text$,
  threadId,
}: ArtifactSidebarContentProps) {
  const fullscreen = fullscreenState.active;
  const toggleFullscreen = fullscreenState.toggle;
  const resetZoomableImageCanvasZoom = useSet(resetZoomableImageCanvasZoom$);
  const display = resolveArtifactDisplay(artifactRef, item);
  const syncTarget = artifactSidebarSyncTargetForItem({
    agentId,
    item,
    onSyncSuccess,
    threadId,
  });

  if (!display) {
    return null;
  }

  return (
    <ArtifactSidebarResolvedContent
      closePreview={onClose}
      display={display}
      fullscreen={fullscreen}
      imageNavigation={imageNavigation}
      onBack={onBack}
      resetZoomableImageCanvasZoom={resetZoomableImageCanvasZoom}
      syncTarget={syncTarget}
      text$={text$}
      toggleFullscreen={toggleFullscreen}
    />
  );
}

type ArtifactSidebarResolvedContentProps = {
  readonly closePreview: () => void;
  readonly display: ArtifactDisplay;
  readonly fullscreen: boolean;
  readonly imageNavigation?: ArtifactImageNavigationActions;
  readonly onBack?: () => void;
  readonly resetZoomableImageCanvasZoom: (key: string) => void;
  readonly syncTarget?: ArtifactDownloadSyncTarget;
  readonly text$?: TextPreviewComputed;
  readonly toggleFullscreen: () => void;
};

function ArtifactSidebarResolvedContent({
  closePreview,
  display,
  fullscreen,
  imageNavigation,
  onBack,
  resetZoomableImageCanvasZoom,
  syncTarget,
  text$,
  toggleFullscreen,
}: ArtifactSidebarResolvedContentProps) {
  return (
    <ArtifactSidebarSurface fullscreen={fullscreen}>
      <ArtifactSidebarHeader
        title={display.filename}
        kind={display.kind}
        artifactKind={display.artifactKind}
        subtitle={display.subtitle}
        syncTarget={syncTarget}
        url={display.url}
        fullscreen={fullscreen}
        onBack={onBack}
        onToggleFullscreen={artifactSidebarFullscreenToggleAction({
          display,
          fullscreen,
          resetZoomableImageCanvasZoom,
          toggleFullscreen,
        })}
        onClose={closePreview}
      />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        <ArtifactBody
          url={display.url}
          kind={display.kind}
          filename={display.filename}
          artifactKind={display.artifactKind}
          imageNavigation={imageNavigation}
          fullscreen={fullscreen}
          text$={text$}
        />
      </div>
    </ArtifactSidebarSurface>
  );
}

function ArtifactSidebarImageNavigationKeydown({
  fullscreen,
  modalOpen,
  navigation,
}: {
  fullscreen: boolean;
  modalOpen: boolean;
  navigation?: ArtifactImageNavigationActions;
}) {
  let cleanup: (() => void) | null = null;

  return (
    <span
      ref={(node) => {
        cleanup?.();
        cleanup = null;
        if (!node || (!navigation?.onPrevious && !navigation?.onNext)) {
          return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
          // When the lightbox modal is open it owns arrow-key navigation; the
          // sidebar must not also react.
          if (modalOpen) {
            return;
          }
          // Focus is only considered in the non-fullscreen sidebar, where the
          // chat composer and other controls remain reachable. In fullscreen
          // the sidebar is immersive, so arrow keys always navigate.
          if (
            shouldIgnoreImageArtifactNavigationKey(event, {
              considerFocus: !fullscreen,
            })
          ) {
            return;
          }
          if (event.key === "ArrowLeft" && navigation.onPrevious) {
            event.preventDefault();
            navigation.onPrevious();
          }
          if (event.key === "ArrowRight" && navigation.onNext) {
            event.preventDefault();
            navigation.onNext();
          }
        };

        document.addEventListener("keydown", onKeyDown);
        cleanup = () => {
          document.removeEventListener("keydown", onKeyDown);
        };
      }}
      hidden
    />
  );
}

function resetArtifactSidebarImageZoom({
  display,
  fullscreen,
  resetZoomableImageCanvasZoom,
}: {
  display: ArtifactDisplay;
  fullscreen: boolean;
  resetZoomableImageCanvasZoom: (key: string) => void;
}) {
  if (display.kind !== "image") {
    return;
  }
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

function artifactSidebarFullscreenToggleAction({
  display,
  fullscreen,
  resetZoomableImageCanvasZoom,
  toggleFullscreen,
}: {
  display: ArtifactDisplay;
  fullscreen: boolean;
  resetZoomableImageCanvasZoom: (key: string) => void;
  toggleFullscreen: () => void;
}) {
  return () => {
    resetArtifactSidebarImageZoom({
      display,
      fullscreen,
      resetZoomableImageCanvasZoom,
    });
    toggleFullscreen();
  };
}

function ArtifactSidebarSurface({
  children,
  fullscreen,
}: {
  children: ReactNode;
  fullscreen: boolean;
}) {
  return (
    <div
      className={cn(
        fullscreen
          ? cn(
              ARTIFACT_FULLSCREEN_SHELL_CLASSNAME,
              ARTIFACT_FULLSCREEN_DEFAULT_LAYER_CLASSNAME,
            )
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0",
        "animate-in fade-in duration-[180ms] ease",
      )}
      data-testid="artifact-sidebar"
    >
      {children}
    </div>
  );
}

interface ArtifactDisplay {
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
  subtitle: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
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
      return artifactPreviewUrlsMatch(candidate.url, url);
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
    disconnected: params.item.file.googleDriveSync?.status === "disconnected",
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
      artifactKind: item.file.artifactKind,
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
  artifactKind,
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
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
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
        <ArtifactActionTooltip label="Back to all artifacts">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to all artifacts"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <IconArrowLeft size={16} />
          </button>
        </ArtifactActionTooltip>
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
        artifactKind={artifactKind}
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
  artifactKind,
  compactActions,
  fullscreen,
  kind,
  onClose,
  onToggleFullscreen,
  syncTarget,
  title,
  url,
}: {
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
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
        <ArtifactSidebarPreviewActions
          artifactKind={artifactKind}
          kind={kind}
          syncTarget={syncTarget}
          title={title}
          url={url}
        />
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

function ArtifactSidebarPreviewActions({
  artifactKind,
  kind,
  syncTarget,
  title,
  url,
}: {
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  kind?: ArtifactKindForBody;
  syncTarget?: ArtifactDownloadSyncTarget;
  title: string;
  url: string;
}) {
  return (
    <>
      {kind === "html" && <ArtifactOpenExternalAction url={url} />}
      <ArtifactShareButton ariaLabel="Share artifact" url={url} />
      <ArtifactDownloadMenu
        ariaLabel="Download artifact"
        artifactKind={artifactKind}
        filename={title}
        menuInstanceKey="artifact-sidebar"
        syncTarget={syncTarget}
        url={url}
      />
      <ArtifactActionSeparator />
    </>
  );
}

function ArtifactOpenExternalAction({ url }: { url: string }) {
  return (
    <ArtifactActionTooltip label="Open in new tab">
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
    </ArtifactActionTooltip>
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
    <ArtifactActionTooltip
      label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
    >
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
    </ArtifactActionTooltip>
  );
}

function ArtifactMoreActions({ onClose }: { onClose: () => void }) {
  return (
    <DropdownMenu>
      <ArtifactActionTooltip label="More artifact actions">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More artifact actions"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <IconDots size={16} />
          </button>
        </DropdownMenuTrigger>
      </ArtifactActionTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onClose}>Close preview</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactCloseAction({ onClose }: { onClose: () => void }) {
  return (
    <ArtifactActionTooltip label="Close artifact">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close artifact"
        data-testid="artifact-sidebar-close"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <IconX size={16} />
      </button>
    </ArtifactActionTooltip>
  );
}

function ArtifactBody({
  url,
  kind,
  filename,
  artifactKind,
  imageNavigation,
  fullscreen,
  text$,
}: {
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  imageNavigation?: ArtifactImageNavigationActions;
  fullscreen: boolean;
  text$?: TextPreviewComputed;
}) {
  if (kind === "markdown") {
    return text$ ? (
      <ArtifactMarkdownBody text$={text$} />
    ) : (
      <ArtifactBodyError message="Preview unavailable." />
    );
  }
  if (kind === "text" || kind === "json") {
    return text$ ? (
      <ArtifactPlainTextBody kind={kind} text$={text$} />
    ) : (
      <ArtifactBodyError message="Preview unavailable." />
    );
  }
  if (kind === "csv") {
    return text$ ? (
      <ArtifactCsvBody text$={text$} />
    ) : (
      <ArtifactBodyError message="Preview unavailable." />
    );
  }
  if (kind === "image") {
    return (
      <ArtifactImageBody
        fullscreen={fullscreen}
        imageNavigation={imageNavigation}
        url={url}
        filename={filename}
      />
    );
  }
  if (kind === "video") {
    return <ArtifactVideoBody url={url} filename={filename} />;
  }
  if (kind === "audio") {
    return <ArtifactAudioBody url={url} filename={filename} />;
  }
  if (kind === "html" || kind === "pdf") {
    return (
      <ArtifactIframeBody
        url={url}
        kind={kind}
        filename={filename}
        artifactKind={artifactKind}
        fullscreen={fullscreen}
      />
    );
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

function ArtifactMarkdownBody({ text$ }: { text$: TextPreviewComputed }) {
  return (
    <TextPreviewLoader text$={text$}>
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
  text$,
}: {
  kind: "text" | "json";
  text$: TextPreviewComputed;
}) {
  return (
    <TextPreviewLoader text$={text$}>
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

function ArtifactCsvBody({ text$ }: { text$: TextPreviewComputed }) {
  return (
    <TextPreviewLoader text$={text$}>
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
  fullscreen,
  imageNavigation,
  url,
  filename,
}: {
  fullscreen: boolean;
  imageNavigation?: ArtifactImageNavigationActions;
  url: string;
  filename: string;
}) {
  const modalOpen = useGet(lightboxDialogVisible$);

  return (
    <ArtifactStageShell flush scrollable={false}>
      <ArtifactStageCard fillHeight>
        <div className="relative h-full min-h-0">
          <ArtifactSidebarImageNavigationKeydown
            fullscreen={fullscreen}
            modalOpen={modalOpen}
            navigation={imageNavigation}
          />
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
          <ArtifactImageNavigationControls navigation={imageNavigation} />
        </div>
      </ArtifactStageCard>
    </ArtifactStageShell>
  );
}

function ArtifactImageNavigationControls({
  navigation,
}: {
  navigation?: ArtifactImageNavigationActions;
}) {
  if (!navigation?.onPrevious && !navigation?.onNext) {
    return null;
  }

  return (
    <>
      {navigation.onPrevious && (
        <button
          type="button"
          onClick={navigation.onPrevious}
          aria-label="Previous image artifact"
          title="Previous image artifact"
          data-testid="artifact-sidebar-previous-image"
          className="absolute left-4 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-muted"
        >
          <IconChevronLeft size={22} stroke={1.8} />
        </button>
      )}
      {navigation.onNext && (
        <button
          type="button"
          onClick={navigation.onNext}
          aria-label="Next image artifact"
          title="Next image artifact"
          data-testid="artifact-sidebar-next-image"
          className="absolute right-4 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-muted"
        >
          <IconChevronRight size={22} stroke={1.8} />
        </button>
      )}
    </>
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
  artifactKind,
  fullscreen,
}: {
  url: string;
  kind: "html" | "pdf";
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  fullscreen: boolean;
}) {
  // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail
  // (thumbnails / bookmarks) so the embedded preview shows just the page
  // and toolbar by default. Firefox/PDF.js silently ignores it.
  const publicUrl = publicAttachmentUrl(url);
  const src = kind === "pdf" ? `${publicUrl}#navpanes=0` : publicUrl;
  const isPresentationHtml =
    kind === "html" && artifactKind === "presentation-html";
  if (kind === "html") {
    return (
      <div className="h-full w-full">
        <AutoFocusedArtifactIframe
          focusKey={`${publicUrl}:${fullscreen ? "fullscreen" : "sidebar"}`}
          focusOnMount={fullscreen && !isPresentationHtml}
          src={publicUrl}
          title={`${filename} preview`}
          sandbox="allow-same-origin allow-scripts"
          tabIndex={isPresentationHtml ? -1 : undefined}
          className="h-full w-full border-0 bg-background"
          data-testid={`artifact-sidebar-body-${kind}`}
        />
      </div>
    );
  }

  return (
    <ArtifactStageShell scrollable={false}>
      <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
        <iframe
          src={src}
          title={`${filename} preview`}
          className="h-full min-h-0 w-full border-0 bg-background"
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
