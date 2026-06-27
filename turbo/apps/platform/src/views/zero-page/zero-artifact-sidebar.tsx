import type { ReactNode } from "react";
import {
  IconArrowLeft,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconDots,
  IconEye,
  IconExternalLink,
  IconLoader2,
  IconPencil,
  IconUpload,
  IconZoomReset,
  IconX,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
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
  artifactHtmlEditMode$,
  artifactFullscreen$,
  type ArtifactRef,
  applyHtmlDomEditPreview$,
  clearHtmlDomEditPending$,
  closeArtifactHtmlEditMode$,
  closeArtifact$,
  discardHtmlDomEditPreviewDraft$,
  htmlDomEditPreviewHtmlByUrl$,
  htmlDomEditPendingUrl$,
  htmlDomEditPublishingUrl$,
  markHtmlDomEditPending$,
  openArtifactHtmlEditMode$,
  openPresentationEditor$,
  publishHtmlDomEditPreviewDraft$,
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
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";
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
  ArtifactActionTooltip,
  ArtifactDownloadMenu,
  ArtifactShareButton,
  type ArtifactDownloadSyncTarget,
} from "./zero-artifact-actions.tsx";
import {
  artifactFallbackSubtitle,
  artifactTitleSubtitle,
} from "./zero-artifact-display.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  presentationHtmlPreviewUrl,
  presentationHtmlRefreshVersion$,
} from "../../signals/zero-page/presentation-html-cache-bust.ts";
import { HtmlDomCommentEditor } from "./html-dom-comment-editor.tsx";
import type { HtmlDomEditDraft } from "./html-dom-edit-types.ts";

// ---------------------------------------------------------------------------
// ArtifactSidebar — page-level pane for previewing the artifact pointed to
// by ?artifact=. Renders kind-specific bodies inline (no modal), with a
// fullscreen toggle that swaps to a full-viewport layout.
// ---------------------------------------------------------------------------

const ARTIFACT_FULLSCREEN_SHELL_CLASSNAME =
  "fixed inset-0 z-[100] flex min-h-0 flex-col bg-background pt-[var(--sat)] pb-[var(--sab)]";

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

type ArtifactSidebarContentProps = {
  agentId?: string | null;
  artifactRef: ArtifactRef;
  item?: ArtifactSidebarItem;
  onBack?: () => void;
  onClose?: () => void;
  onSyncSuccess?: () => void;
  threadId?: string;
};

type HtmlArtifactHeaderState = "idle" | "editing" | "working" | "preview";

function ArtifactSidebarWithThreadData({
  artifactRef,
  onBack,
  onClose,
  thread,
}: ArtifactSidebarProps & { thread: ChatThreadSignals }) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = useLastResolved(thread.agentId$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
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
        reloadArtifacts();
      }}
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

function shouldOpenHtmlCommentMode(
  display: ArtifactDisplay | null,
  requested: boolean,
): boolean {
  return (
    requested &&
    display?.kind === "html" &&
    display.artifactKind === "hosted-site"
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
}: ArtifactSidebarContentProps) {
  const fullscreen = useGet(artifactFullscreen$);
  const requestedHtmlCommentMode = useGet(artifactHtmlEditMode$);
  const htmlDomEditPreviewHtmlByUrl = useGet(htmlDomEditPreviewHtmlByUrl$);
  const htmlDomEditPendingUrl = useGet(htmlDomEditPendingUrl$);
  const htmlDomEditPublishingUrl = useGet(htmlDomEditPublishingUrl$);
  const applyHtmlDomEditPreview = useSet(applyHtmlDomEditPreview$);
  const close = useSet(closeArtifact$);
  const clearHtmlDomEditPending = useSet(clearHtmlDomEditPending$);
  const closeHtmlCommentMode = useSet(closeArtifactHtmlEditMode$);
  const markHtmlDomEditPending = useSet(markHtmlDomEditPending$);
  const openHtmlCommentMode = useSet(openArtifactHtmlEditMode$);
  const toggleFullscreen = useSet(toggleArtifactFullscreen$);
  const resetZoomableImageCanvasZoom = useSet(resetZoomableImageCanvasZoom$);
  const pageSignal = useGet(pageSignal$);
  const closePreview = onClose ?? close;
  const openPresentationEditor = useSet(openPresentationEditor$);
  const features = useLastResolved(featureSwitch$);
  const htmlEditFeatureEnabled = Boolean(
    features?.[FeatureSwitchKey.HtmlArtifactCommentEditing],
  );

  const display = resolveArtifactDisplay(artifactRef, item);
  const htmlCommentMode =
    htmlEditFeatureEnabled &&
    shouldOpenHtmlCommentMode(display, requestedHtmlCommentMode);
  const syncTarget = artifactSidebarSyncTargetForItem({
    agentId,
    item,
    onSyncSuccess,
    threadId,
  });
  const htmlEditState = createHtmlEditState({
    applyPreview: applyHtmlDomEditPreview,
    clearPending: clearHtmlDomEditPending,
    closeCommentMode: closeHtmlCommentMode,
    display,
    pendingUrl: htmlDomEditPendingUrl,
    publishingUrl: htmlDomEditPublishingUrl,
    previewHtmlByUrl: htmlDomEditPreviewHtmlByUrl,
    markPending: markHtmlDomEditPending,
  });
  const htmlHeaderState = htmlArtifactHeaderState({
    display,
    htmlCommentMode,
    previewHtml: htmlEditState.previewHtml,
    status: htmlEditState.status,
  });

  if (!display) {
    return (
      <ArtifactUnavailableSidebar
        fullscreen={fullscreen}
        onBack={onBack}
        onClose={closePreview}
        onToggleFullscreen={toggleFullscreen}
      />
    );
  }

  const editPresentation =
    display.artifactKind === "presentation-html"
      ? () => {
          openPresentationEditor(display.url);
        }
      : undefined;
  const editHtml =
    display.kind === "html" &&
    display.artifactKind === "hosted-site" &&
    !htmlCommentMode &&
    htmlHeaderState === "idle"
      ? openHtmlCommentMode
      : undefined;
  const toggleFullscreenWithImageReset = () => {
    resetArtifactSidebarImageZoom({
      display,
      fullscreen,
      resetZoomableImageCanvasZoom,
    });
    toggleFullscreen();
  };
  const exitHtmlEdit = htmlEditExitAction(
    htmlHeaderState,
    closeHtmlCommentMode,
  );

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
        htmlState={htmlHeaderState}
        onEditPresentation={editPresentation}
        onEditHtml={editHtml}
        onExitHtmlEdit={exitHtmlEdit}
        onBack={onBack}
        onToggleFullscreen={toggleFullscreenWithImageReset}
        onClose={closePreview}
      />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        <ArtifactBody
          url={display.url}
          kind={display.kind}
          filename={display.filename}
          artifactKind={display.artifactKind}
          htmlEditStatus={htmlEditState.status}
          htmlPreviewHtml={htmlEditState.previewHtml}
          htmlCommentMode={htmlCommentMode}
          onCloseHtmlCommentMode={closeHtmlCommentMode}
          onApplyHtmlEditDraft={htmlEditState.apply}
          onHtmlEditRequestFailed={htmlEditState.fail}
          onHtmlEditRequestStarted={htmlEditState.start}
          pageSignal={pageSignal}
        />
      </div>
    </ArtifactSidebarSurface>
  );
}

function ArtifactUnavailableSidebar({
  fullscreen,
  onBack,
  onClose,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onBack?: () => void;
  onClose: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <ArtifactSidebarSurface fullscreen={fullscreen}>
      <ArtifactSidebarHeader
        title="Artifact unavailable"
        subtitle="Unavailable"
        fullscreen={fullscreen}
        onBack={onBack}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
      />
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        Unsupported artifact reference.
      </div>
    </ArtifactSidebarSurface>
  );
}

function createHtmlEditState({
  applyPreview,
  clearPending,
  closeCommentMode,
  display,
  markPending,
  pendingUrl,
  publishingUrl,
  previewHtmlByUrl,
}: {
  applyPreview: (params: {
    readonly url: string;
    readonly html: string;
  }) => void;
  clearPending: (url: string) => void;
  closeCommentMode: () => void;
  display: ArtifactDisplay | null;
  markPending: (url: string) => void;
  pendingUrl: string | null;
  publishingUrl: string | null;
  previewHtmlByUrl: Readonly<Record<string, string>>;
}) {
  if (!display) {
    return {};
  }
  const status =
    display.kind === "html" &&
    (pendingUrl === display.url || publishingUrl === display.url)
      ? ("working" as const)
      : undefined;
  const previewHtml =
    display.kind === "html" ? previewHtmlByUrl[display.url] : undefined;
  return {
    apply: (draft: HtmlDomEditDraft) => {
      applyPreview({ url: display.url, html: draft.html });
      closeCommentMode();
      return Promise.resolve();
    },
    fail: () => {
      clearPending(display.url);
    },
    start: () => {
      markPending(display.url);
    },
    previewHtml,
    status,
  };
}

function htmlArtifactHeaderState({
  display,
  htmlCommentMode,
  previewHtml,
  status,
}: {
  display: ArtifactDisplay | null;
  htmlCommentMode: boolean;
  previewHtml?: string;
  status?: "working";
}): HtmlArtifactHeaderState | undefined {
  if (
    !display ||
    display.kind !== "html" ||
    display.artifactKind !== "hosted-site"
  ) {
    return undefined;
  }
  if (status === "working") {
    return "working";
  }
  if (htmlCommentMode) {
    return "editing";
  }
  if (previewHtml) {
    return "preview";
  }
  return "idle";
}

function htmlEditExitAction(
  state: HtmlArtifactHeaderState | undefined,
  closeHtmlCommentMode: () => void,
): (() => void) | undefined {
  return state === "editing" ? closeHtmlCommentMode : undefined;
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
          ? ARTIFACT_FULLSCREEN_SHELL_CLASSNAME
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
  htmlState,
  onBack,
  onEditHtml,
  onEditPresentation,
  onExitHtmlEdit,
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
  htmlState?: HtmlArtifactHeaderState;
  onBack?: () => void;
  onEditHtml?: () => void;
  onEditPresentation?: () => void;
  onExitHtmlEdit?: () => void;
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
        htmlState={htmlState}
        kind={kind}
        onClose={onClose}
        onEditHtml={onEditHtml}
        onEditPresentation={onEditPresentation}
        onExitHtmlEdit={onExitHtmlEdit}
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
  htmlState,
  kind,
  onClose,
  onEditHtml,
  onEditPresentation,
  onExitHtmlEdit,
  onToggleFullscreen,
  syncTarget,
  title,
  url,
}: {
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  compactActions: boolean;
  fullscreen: boolean;
  htmlState?: HtmlArtifactHeaderState;
  kind?: ArtifactKindForBody;
  onClose: () => void;
  onEditHtml?: () => void;
  onEditPresentation?: () => void;
  onExitHtmlEdit?: () => void;
  onToggleFullscreen: () => void;
  syncTarget?: ArtifactDownloadSyncTarget;
  title: string;
  url?: string;
}) {
  const features = useLastResolved(featureSwitch$);
  const showPresentationEdit =
    artifactKind === "presentation-html" && onEditPresentation !== undefined;
  const showHtmlControls =
    kind === "html" &&
    artifactKind === "hosted-site" &&
    Boolean(features?.[FeatureSwitchKey.HtmlArtifactCommentEditing]) &&
    htmlState !== undefined;
  const htmlEditActive = showHtmlControls && htmlState !== "idle";

  return (
    <div className="flex shrink-0 items-center gap-1">
      {url && (
        <>
          {!htmlEditActive && (
            <>
              {kind === "html" && <ArtifactOpenExternalAction url={url} />}
              <ArtifactShareButton ariaLabel="Share artifact" url={url} />
              <ArtifactDownloadMenu
                ariaLabel="Download artifact"
                artifactKind={artifactKind}
                filename={title}
                syncTarget={syncTarget}
                url={url}
              />
              <ArtifactActionSeparator />
              {showPresentationEdit && (
                <>
                  <ArtifactEditPresentationAction
                    onClick={onEditPresentation}
                  />
                  <ArtifactActionSeparator />
                </>
              )}
            </>
          )}
          {showHtmlControls && (
            <>
              <ArtifactHtmlEditStatus state={htmlState} />
              {htmlState === "editing" && onExitHtmlEdit && (
                <ArtifactExitHtmlEditAction onClick={onExitHtmlEdit} />
              )}
              {onEditHtml && <ArtifactEditHtmlAction onClick={onEditHtml} />}
              <ArtifactActionSeparator />
            </>
          )}
        </>
      )}
      <ArtifactFullscreenAction
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      {!htmlEditActive &&
        (compactActions ? (
          <ArtifactMoreActions onClose={onClose} />
        ) : (
          <ArtifactCloseAction onClose={onClose} />
        ))}
    </div>
  );
}

function ArtifactEditPresentationAction({ onClick }: { onClick: () => void }) {
  return (
    <ArtifactActionTooltip label="Edit presentation">
      <button
        type="button"
        onClick={onClick}
        aria-label="Edit presentation"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <IconPencil size={16} stroke={1.5} />
      </button>
    </ArtifactActionTooltip>
  );
}

function ArtifactEditHtmlAction({ onClick }: { onClick: () => void }) {
  return (
    <ArtifactActionTooltip label="Edit page">
      <button
        type="button"
        onClick={onClick}
        aria-label="Edit page"
        data-testid="artifact-sidebar-edit-html"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <IconPencil size={16} stroke={1.5} />
      </button>
    </ArtifactActionTooltip>
  );
}

function ArtifactExitHtmlEditAction({ onClick }: { onClick: () => void }) {
  return (
    <ArtifactActionTooltip label="Exit editing and keep preview open">
      <button
        type="button"
        onClick={onClick}
        aria-label="Exit editing and keep preview open"
        data-testid="artifact-sidebar-exit-html-edit"
        className="inline-flex h-8 items-center rounded-full border border-border/80 bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted/60"
      >
        Exit
      </button>
    </ArtifactActionTooltip>
  );
}

function ArtifactHtmlEditStatus({
  state,
}: {
  state?: HtmlArtifactHeaderState;
}) {
  if (!state || state === "idle") {
    return null;
  }

  const content = htmlEditStatusContent(state);
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        content.className,
      )}
      data-testid="artifact-sidebar-html-edit-status"
    >
      {content.icon}
      <span>{content.label}</span>
    </span>
  );
}

function htmlEditStatusContent(
  state: Exclude<HtmlArtifactHeaderState, "idle">,
) {
  if (state === "editing") {
    return {
      className: "border-blue-200 bg-blue-50 text-blue-700",
      icon: <IconPencil size={14} stroke={1.9} />,
      label: "Editing",
    };
  }
  if (state === "working") {
    return {
      className: "border-amber-200 bg-amber-50 text-amber-700",
      icon: <IconLoader2 size={14} className="animate-spin" />,
      label: "Working",
    };
  }
  return {
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: <IconEye size={14} stroke={1.9} />,
    label: "Preview draft",
  };
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
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
  htmlEditStatus,
  htmlPreviewHtml,
  htmlCommentMode,
  onCloseHtmlCommentMode,
  onApplyHtmlEditDraft,
  onHtmlEditRequestFailed,
  onHtmlEditRequestStarted,
  pageSignal,
}: {
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  htmlEditStatus?: "working";
  htmlPreviewHtml?: string;
  htmlCommentMode: boolean;
  onCloseHtmlCommentMode: () => void;
  onApplyHtmlEditDraft?: (draft: HtmlDomEditDraft) => Promise<void>;
  onHtmlEditRequestFailed?: () => void;
  onHtmlEditRequestStarted?: () => void;
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
    if (kind === "html" && artifactKind === "hosted-site" && htmlCommentMode) {
      return (
        <HtmlDomCommentEditor
          key={url}
          filename={filename}
          onApplyEditDraft={onApplyHtmlEditDraft}
          onClose={onCloseHtmlCommentMode}
          onEditRequestFailed={onHtmlEditRequestFailed}
          onEditRequestStarted={onHtmlEditRequestStarted}
          pageSignal={pageSignal}
          status={htmlEditStatus}
          url={url}
        />
      );
    }
    return (
      <ArtifactIframeBody
        url={url}
        kind={kind}
        filename={filename}
        artifactKind={artifactKind}
        htmlEditStatus={htmlEditStatus}
        htmlPreviewHtml={htmlPreviewHtml}
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
  artifactKind,
  htmlEditStatus,
  htmlPreviewHtml,
}: {
  url: string;
  kind: "html" | "pdf";
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  htmlEditStatus?: "working";
  htmlPreviewHtml?: string;
}) {
  // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail
  // (thumbnails / bookmarks) so the embedded preview shows just the page
  // and toolbar by default. Firefox/PDF.js silently ignores it.
  const publicUrl = publicAttachmentUrl(url);
  const src = kind === "pdf" ? `${publicUrl}#navpanes=0` : publicUrl;
  const fullscreen = useGet(artifactFullscreen$);
  const pageSignal = useGet(pageSignal$);
  const discardHtmlDomEditPreviewDraft = useSet(
    discardHtmlDomEditPreviewDraft$,
  );
  const publishHtmlDomEditPreviewDraft = useSet(
    publishHtmlDomEditPreviewDraft$,
  );
  const htmlRefreshVersion = useGet(presentationHtmlRefreshVersion$);
  const isPresentationHtml =
    kind === "html" && artifactKind === "presentation-html";
  if (kind === "html") {
    const versionedSrc = presentationHtmlPreviewUrl(
      publicUrl,
      htmlRefreshVersion,
    );
    return (
      <div className="relative h-full w-full">
        <AutoFocusedArtifactIframe
          focusKey={`${versionedSrc}:${fullscreen ? "fullscreen" : "sidebar"}`}
          focusOnMount={fullscreen && !isPresentationHtml}
          {...(htmlPreviewHtml
            ? { srcDoc: htmlPreviewHtml }
            : { src: versionedSrc })}
          title={`${filename} preview`}
          sandbox="allow-same-origin allow-scripts"
          tabIndex={isPresentationHtml ? -1 : undefined}
          className="h-full w-full border-0 bg-background"
          data-testid={`artifact-sidebar-body-${kind}`}
        />
        {htmlPreviewHtml ? (
          <HtmlEditDraftToolbar
            disabled={htmlEditStatus === "working"}
            onDiscard={() => {
              discardHtmlDomEditPreviewDraft(url);
            }}
            onPublish={() => {
              detach(
                publishHtmlDomEditPreviewDraft(url, pageSignal),
                Reason.DomCallback,
                "publishHtmlDomEditPreviewDraft",
              );
            }}
          />
        ) : null}
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

function HtmlEditDraftToolbar({
  disabled,
  onDiscard,
  onPublish,
}: {
  disabled: boolean;
  onDiscard: () => void;
  onPublish: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4"
      data-testid="html-dom-draft-toolbar"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/70 bg-background/95 px-2 py-2 shadow-xl backdrop-blur">
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          disabled={disabled}
          onClick={onDiscard}
          data-testid="html-dom-draft-discard"
        >
          Discard
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={disabled}
          onClick={onPublish}
          data-testid="html-dom-draft-publish"
        >
          <IconUpload size={16} stroke={1.9} />
          Publish
        </button>
      </div>
    </div>
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
