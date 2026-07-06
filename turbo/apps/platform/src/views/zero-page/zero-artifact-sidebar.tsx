import {
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  IconArrowLeft,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconBackground,
  IconBrandInstagram,
  IconBrandSlack,
  IconBrandX,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconDots,
  IconEye,
  IconExternalLink,
  IconLoader2,
  IconLink,
  IconPalette,
  IconPaperclip,
  IconPencil,
  IconPlus,
  IconShare,
  IconSparkles,
  IconTrash,
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
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui";
import {
  artifactHtmlEditMode$,
  artifactFullscreen$,
  type ArtifactRef,
  applyHtmlDomEditPreview$,
  clearHtmlDomEditPending$,
  closeArtifact$,
  closeArtifactHtmlEditMode$,
  clearHtmlEditSnapshotRestorePendingResumeKey$,
  deleteHtmlEditSnapshotDraft$,
  dismissHtmlEditSnapshotRestoreDraft$,
  discardHtmlDomEditPreviewDraft$,
  continueHtmlEditSnapshotDraft$,
  htmlEditSnapshotRestoreDraft$,
  htmlEditSnapshotRestoreIntentUrl$,
  htmlEditSnapshotRestorePendingResumeKey$,
  htmlDomEditPreviewHtmlByUrl$,
  htmlDomEditPendingUrl$,
  htmlDomEditPublishingUrl$,
  markHtmlDomEditPending$,
  navigateArtifactSidebarImage$,
  openArtifactHtmlEditMode$,
  openPresentationEditor$,
  publishHtmlDomEditPreviewDraft$,
  saveCapturedHtmlEditSnapshotDraft$,
  setHtmlEditSnapshotControllerRef$,
  setHtmlEditSnapshotRestorePendingResumeKey$,
  toggleArtifactFullscreen$,
} from "../../signals/zero-page/zero-artifact-sidebar.ts";
import {
  CsvPreviewTable,
  downloadAttachmentUrl,
  parseCsvRows,
  publicAttachmentUrl,
  TextPreviewLoader,
} from "./zero-attachment-chips.tsx";
import { artifactPreviewUrlsMatch } from "./zero-attachment-url.ts";
import { lightboxDialogVisible$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  artifactImageEditMode$,
  importEditableImageCanvasImageUrl$,
  imageEditUploading$,
  runImageEdit$,
  type ImageEditOperation,
  uploadEditableImageCanvasImage$,
} from "../../signals/zero-page/zero-image-edit.ts";
import { Markdown } from "../components/markdown.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  detach,
  jsonParseOr,
  Reason,
  withCleanup,
} from "../../signals/utils.ts";
import { resetZoomableImageCanvasZoom$ } from "../../signals/view-component-state.ts";
import {
  ZoomableArtifactImageCanvas,
  type ZoomableImageControls,
  zoomableArtifactImageKey,
} from "./zero-zoomable-image-canvas.tsx";
import { EditableArtifactImageCanvas } from "./zero-editable-image-canvas.tsx";
import {
  editableImageArtifactCanvasKey,
  deleteEditableImageCanvasItem$,
  type EditableImageCanvasItem,
} from "../../signals/zero-page/zero-editable-image-canvas.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { ChatThreadSignals } from "../../signals/chat-page/chat-thread-signals.ts";
import type { ChatThreadArtifactFile } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ArtifactActionSeparator,
  ArtifactActionTooltip,
  ArtifactDownloadMenu,
  ArtifactShareButton,
  type ArtifactDownloadSyncTarget,
} from "./zero-artifact-actions.tsx";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";
import {
  artifactFallbackSubtitle,
  artifactTitleSubtitle,
} from "./zero-artifact-display.ts";
import {
  currentMessageImageArtifactNavigation,
  type ImageArtifactNavigationItem,
  shouldIgnoreImageArtifactNavigationKey,
} from "./zero-artifact-image-navigation.ts";
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
  "fixed inset-0 flex min-h-0 flex-col bg-background pt-[var(--sat)] pb-[var(--sab)]";
const ARTIFACT_FULLSCREEN_DEFAULT_LAYER_CLASSNAME = "z-[100]";
const ARTIFACT_FULLSCREEN_EDIT_LAYER_CLASSNAME = "z-[9999]";

export function ArtifactSidebar({
  artifactRef,
  onBack,
  onClose,
  thread,
}: ArtifactSidebarProps) {
  if (thread) {
    return (
      <ArtifactSidebarWithThreadContext
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

type ArtifactImageNavigationActions = {
  readonly onNext?: () => void;
  readonly onPrevious?: () => void;
};

type ArtifactSidebarContentProps = {
  agentId?: string | null;
  artifactRef: ArtifactRef;
  imageNavigation?: ArtifactImageNavigationActions;
  item?: ArtifactSidebarItem;
  onBack?: () => void;
  onClose?: () => void;
  onSyncSuccess?: () => void;
  threadId?: string;
};

type HtmlArtifactHeaderState = "idle" | "editing" | "working" | "preview";
type HtmlEditState = ReturnType<typeof createHtmlEditState>;

function ArtifactSidebarWithThreadContext({
  artifactRef,
  onBack,
  onClose,
  thread,
}: ArtifactSidebarProps & { thread: ChatThreadSignals }) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = useLastResolved(thread.agentId$);
  const messageGroups = useLastResolved(thread.groupedChatMessages$);
  const features = useLastResolved(featureSwitch$);
  const imageNavigationEnabled = Boolean(
    features?.[FeatureSwitchKey.ImageArtifactKeyboardNavigation],
  );
  const navigateArtifactSidebarImage = useSet(navigateArtifactSidebarImage$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const item =
    artifactRef.source === "url" && loadable.state === "hasData"
      ? findArtifactItemForUrl(loadable.data, artifactRef.url)
      : undefined;
  const imageNavigation =
    imageNavigationEnabled &&
    artifactRef.source === "url" &&
    loadable.state === "hasData"
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
      navigateArtifactSidebarImage(navigationItem.url);
    };
  };

  return (
    <ArtifactSidebarContent
      agentId={agentId}
      artifactRef={artifactRef}
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
      threadId={thread.threadId}
    />
  );
}

function noop() {
  return undefined;
}

interface HtmlEditSnapshotRestoreDraftView {
  readonly threadId: string;
  readonly updatedAt: string;
  readonly url: string;
}

type HtmlEditSnapshotTargetView = {
  readonly threadId: string;
  readonly url: string;
};

function HtmlEditSnapshotController({
  previewHtml,
  signal,
  target,
}: {
  readonly previewHtml?: string;
  readonly signal: AbortSignal;
  readonly target: HtmlEditSnapshotTargetView | null;
}) {
  const restoreDraft = useGet(htmlEditSnapshotRestoreDraft$);
  const continueHtmlEditSnapshotDraft = useSet(continueHtmlEditSnapshotDraft$);
  const deleteHtmlEditSnapshotDraft = useSet(deleteHtmlEditSnapshotDraft$);
  const dismissHtmlEditSnapshotRestoreDraft = useSet(
    dismissHtmlEditSnapshotRestoreDraft$,
  );
  const setHtmlEditSnapshotControllerRef = useSet(
    setHtmlEditSnapshotControllerRef$,
  );

  return (
    <div
      key={target ? `${target.threadId}\n${target.url}` : "none"}
      ref={setHtmlEditSnapshotControllerRef}
      data-html-edit-snapshot-thread-id={target?.threadId}
      data-html-edit-snapshot-url={target?.url}
      data-html-edit-snapshot-has-preview={previewHtml ? "1" : undefined}
    >
      <HtmlEditSnapshotRestoreDialog
        restoreDraft={htmlEditSnapshotRestoreDraftForTarget(
          restoreDraft,
          target,
        )}
        signal={signal}
        onContinue={continueHtmlEditSnapshotDraft}
        onDismiss={dismissHtmlEditSnapshotRestoreDraft}
        onDiscard={(currentDraft) => {
          detach(
            deleteHtmlEditSnapshotDraft(
              {
                threadId: currentDraft.threadId,
                url: currentDraft.url,
              },
              signal,
            ),
            Reason.DomCallback,
            "discardHtmlEditSnapshotDraft",
          );
        }}
      />
    </div>
  );
}

function htmlEditSnapshotRestoreDraftForTarget(
  restoreDraft: HtmlEditSnapshotRestoreDraftView | null,
  target: HtmlEditSnapshotTargetView | null,
): HtmlEditSnapshotRestoreDraftView | null {
  return restoreDraft &&
    target &&
    restoreDraft.threadId === target.threadId &&
    restoreDraft.url === target.url
    ? restoreDraft
    : null;
}

function htmlEditSnapshotTargetForDisplay({
  display,
  htmlCommentMode,
  threadId,
}: {
  readonly display: ArtifactDisplay | null;
  readonly htmlCommentMode: boolean;
  readonly threadId?: string;
}): HtmlEditSnapshotTargetView | null {
  return threadId &&
    htmlCommentMode &&
    display?.kind === "html" &&
    display.artifactKind === "hosted-site"
    ? { threadId, url: display.url }
    : null;
}

function htmlEditSnapshotRestoreTargetForDisplay({
  display,
  htmlCommentMode,
  restoreIntentUrl,
  threadId,
}: {
  readonly display: ArtifactDisplay | null;
  readonly htmlCommentMode: boolean;
  readonly restoreIntentUrl: string | null;
  readonly threadId?: string;
}): HtmlEditSnapshotTargetView | null {
  return restoreIntentUrl === display?.url
    ? htmlEditSnapshotTargetForDisplay({ display, htmlCommentMode, threadId })
    : null;
}

function HtmlEditSnapshotRestoreDialog({
  onContinue,
  onDiscard,
  onDismiss,
  restoreDraft,
  signal,
}: {
  readonly onContinue: (
    args: {
      readonly threadId: string;
      readonly url: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly onDiscard: (restoreDraft: HtmlEditSnapshotRestoreDraftView) => void;
  readonly onDismiss: () => void;
  readonly restoreDraft: HtmlEditSnapshotRestoreDraftView | null;
  readonly signal: AbortSignal;
}) {
  const open = Boolean(restoreDraft);
  const restoreDraftKey = restoreDraft
    ? `${restoreDraft.threadId}\n${restoreDraft.url}\n${restoreDraft.updatedAt}`
    : null;
  const pendingResumeDraftKey = useGet(
    htmlEditSnapshotRestorePendingResumeKey$,
  );
  const setPendingResumeDraftKey = useSet(
    setHtmlEditSnapshotRestorePendingResumeKey$,
  );
  const clearPendingResumeDraftKey = useSet(
    clearHtmlEditSnapshotRestorePendingResumeKey$,
  );
  const resumePending =
    restoreDraftKey !== null && pendingResumeDraftKey === restoreDraftKey;
  const resumeDraft = async (
    currentDraft: HtmlEditSnapshotRestoreDraftView,
    currentDraftKey: string,
  ): Promise<void> => {
    setPendingResumeDraftKey(currentDraftKey);
    await withCleanup(
      onContinue(
        {
          threadId: currentDraft.threadId,
          url: currentDraft.url,
        },
        signal,
      ),
      () => {
        clearPendingResumeDraftKey(currentDraftKey);
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onDismiss();
        }
      }}
    >
      <DialogContent
        className="!z-[10000]"
        data-testid="html-edit-snapshot-restore-dialog"
        overlayClassName="!z-[10000]"
      >
        <DialogHeader>
          <DialogTitle>Resume HTML draft?</DialogTitle>
          <DialogDescription>
            A saved HTML draft is available for this artifact.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={resumePending}
            onClick={() => {
              if (restoreDraft) {
                onDiscard(restoreDraft);
              }
            }}
          >
            Discard
          </Button>
          <Button
            aria-busy={resumePending ? true : undefined}
            disabled={resumePending}
            onClick={() => {
              if (!restoreDraft || !restoreDraftKey || resumePending) {
                return;
              }
              detach(
                resumeDraft(restoreDraft, restoreDraftKey),
                Reason.DomCallback,
                "continueHtmlEditSnapshotDraft",
              );
            }}
          >
            {resumePending ? (
              <IconLoader2 size={16} className="animate-spin" />
            ) : null}
            Resume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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

function isHtmlEditFeatureEnabled(
  features: Record<string, boolean> | null | undefined,
): boolean {
  return Boolean(features?.[FeatureSwitchKey.HtmlArtifactCommentEditing]);
}

function ArtifactSidebarContent({
  agentId,
  artifactRef,
  imageNavigation,
  item,
  onBack,
  onClose,
  onSyncSuccess,
  threadId,
}: ArtifactSidebarContentProps) {
  const fullscreen = useGet(artifactFullscreen$);
  const requestedHtmlCommentMode = useGet(artifactHtmlEditMode$);
  const requestedImageEditMode = useGet(artifactImageEditMode$);
  const htmlDomEditPreviewHtmlByUrl = useGet(htmlDomEditPreviewHtmlByUrl$);
  const htmlEditSnapshotRestoreIntentUrl = useGet(
    htmlEditSnapshotRestoreIntentUrl$,
  );
  const htmlDomEditPendingUrl = useGet(htmlDomEditPendingUrl$);
  const htmlDomEditPublishingUrl = useGet(htmlDomEditPublishingUrl$);
  const applyHtmlDomEditPreview = useSet(applyHtmlDomEditPreview$);
  const close = useSet(closeArtifact$);
  const clearHtmlDomEditPending = useSet(clearHtmlDomEditPending$);
  const closeHtmlCommentMode = useSet(closeArtifactHtmlEditMode$);
  const markHtmlDomEditPending = useSet(markHtmlDomEditPending$);
  const openHtmlCommentMode = useSet(openArtifactHtmlEditMode$);
  const publishHtmlDomEditPreviewDraft = useSet(
    publishHtmlDomEditPreviewDraft$,
  );
  const saveCapturedHtmlEditSnapshotDraft = useSet(
    saveCapturedHtmlEditSnapshotDraft$,
  );
  const toggleFullscreen = useSet(toggleArtifactFullscreen$);
  const resetZoomableImageCanvasZoom = useSet(resetZoomableImageCanvasZoom$);
  const pageSignal = useGet(pageSignal$);
  const closePreview = onClose ?? close;
  const openPresentationEditor = useSet(openPresentationEditor$);
  const features = useLastResolved(featureSwitch$);

  const display = resolveArtifactDisplay(artifactRef, item);
  const htmlEditEnabled = isHtmlEditFeatureEnabled(features);
  const htmlCommentMode =
    htmlEditEnabled &&
    shouldOpenHtmlCommentMode(display, requestedHtmlCommentMode);
  const htmlEditSnapshotTarget = htmlEditSnapshotTargetForDisplay({
    display,
    htmlCommentMode,
    threadId,
  });
  const htmlEditSnapshotRestoreTarget = htmlEditSnapshotRestoreTargetForDisplay(
    {
      display,
      htmlCommentMode,
      restoreIntentUrl: htmlEditSnapshotRestoreIntentUrl,
      threadId,
    },
  );
  const syncTarget = artifactSidebarSyncTargetForItem({
    agentId,
    item,
    onSyncSuccess,
    threadId,
  });

  if (!display) {
    return null;
  }

  const imageEditEnabled = Boolean(features?.[FeatureSwitchKey.ImageEditing]);
  const imageEditActive =
    display.kind === "image" && requestedImageEditMode && imageEditEnabled;

  const htmlEditState = createHtmlEditState({
    applyPreview: applyHtmlDomEditPreview,
    clearPending: clearHtmlDomEditPending,
    closeCommentMode: closeHtmlCommentMode,
    display,
    pendingUrl: htmlDomEditPendingUrl,
    publishingUrl: htmlDomEditPublishingUrl,
    previewHtmlByUrl: htmlDomEditPreviewHtmlByUrl,
    markPending: markHtmlDomEditPending,
    saveDraft: saveCapturedHtmlEditSnapshotDraft,
    snapshotTarget: htmlEditSnapshotTarget,
  });
  const htmlHeaderState = htmlArtifactHeaderState({
    display,
    htmlCommentMode,
    previewHtml: htmlEditState.previewHtml,
    status: htmlEditState.status,
  });

  return (
    <ArtifactSidebarResolvedContent
      closeHtmlCommentMode={closeHtmlCommentMode}
      closePreview={closePreview}
      display={display}
      fullscreen={fullscreen}
      htmlCommentMode={htmlCommentMode}
      htmlEditSnapshotRestoreTarget={htmlEditSnapshotRestoreTarget}
      htmlEditState={htmlEditState}
      htmlHeaderState={htmlHeaderState}
      imageEditActive={imageEditActive}
      imageNavigation={imageNavigation}
      onBack={onBack}
      openHtmlCommentMode={openHtmlCommentMode}
      openPresentationEditor={openPresentationEditor}
      pageSignal={pageSignal}
      publishHtmlDomEditPreviewDraft={publishHtmlDomEditPreviewDraft}
      resetZoomableImageCanvasZoom={resetZoomableImageCanvasZoom}
      syncTarget={syncTarget}
      threadId={threadId}
      toggleFullscreen={toggleFullscreen}
    />
  );
}

function ArtifactSidebarResolvedContent({
  closeHtmlCommentMode,
  closePreview,
  display,
  fullscreen,
  htmlCommentMode,
  htmlEditSnapshotRestoreTarget,
  htmlEditState,
  htmlHeaderState,
  imageEditActive,
  imageNavigation,
  onBack,
  openHtmlCommentMode,
  openPresentationEditor,
  pageSignal,
  publishHtmlDomEditPreviewDraft,
  resetZoomableImageCanvasZoom,
  syncTarget,
  threadId,
  toggleFullscreen,
}: {
  readonly closeHtmlCommentMode: () => void;
  readonly closePreview: () => void;
  readonly display: ArtifactDisplay;
  readonly fullscreen: boolean;
  readonly htmlCommentMode: boolean;
  readonly htmlEditSnapshotRestoreTarget: HtmlEditSnapshotTargetView | null;
  readonly htmlEditState: HtmlEditState;
  readonly htmlHeaderState: HtmlArtifactHeaderState | undefined;
  readonly imageEditActive: boolean;
  readonly imageNavigation?: ArtifactImageNavigationActions;
  readonly onBack?: () => void;
  readonly openHtmlCommentMode: () => void;
  readonly openPresentationEditor: (url: string) => void;
  readonly pageSignal: AbortSignal;
  readonly publishHtmlDomEditPreviewDraft: (
    args: string | { readonly threadId?: string; readonly url: string },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly resetZoomableImageCanvasZoom: (key: string) => void;
  readonly syncTarget?: ArtifactDownloadSyncTarget;
  readonly threadId?: string;
  readonly toggleFullscreen: () => void;
}) {
  const applyHtmlStyleEdits = createHtmlStyleEditApplyAction({
    display,
    htmlEditState,
    pageSignal,
    publishPreviewDraft: publishHtmlDomEditPreviewDraft,
  });
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
  const exitHtmlEdit = htmlEditExitAction(
    htmlHeaderState,
    closeHtmlCommentMode,
  );

  return (
    <ArtifactSidebarSurface
      editing={htmlCommentMode || imageEditActive}
      fullscreen={fullscreen}
    >
      <ArtifactSidebarHeader
        title={display.filename}
        kind={display.kind}
        artifactKind={display.artifactKind}
        subtitle={display.subtitle}
        syncTarget={syncTarget}
        url={display.url}
        fullscreen={fullscreen}
        htmlState={htmlHeaderState}
        imageEditActive={imageEditActive}
        onEditPresentation={editPresentation}
        onEditHtml={editHtml}
        onExitHtmlEdit={exitHtmlEdit}
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
          htmlEditStatus={htmlEditState.status}
          htmlPreviewHtml={htmlEditState.previewHtml}
          htmlCommentMode={htmlCommentMode}
          imageNavigation={imageNavigation}
          onCloseHtmlCommentMode={closeHtmlCommentMode}
          onApplyHtmlEditDraft={htmlEditState.apply}
          onApplyHtmlStyleEdits={applyHtmlStyleEdits}
          onHtmlEditRequestFailed={htmlEditState.fail}
          onHtmlEditRequestStarted={htmlEditState.start}
          pageSignal={pageSignal}
          threadId={threadId}
        />
      </div>
      <HtmlEditSnapshotController
        previewHtml={htmlEditState.previewHtml}
        signal={pageSignal}
        target={htmlEditSnapshotRestoreTarget}
      />
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

function createHtmlEditState({
  applyPreview,
  clearPending,
  closeCommentMode,
  display,
  markPending,
  pendingUrl,
  publishingUrl,
  previewHtmlByUrl,
  saveDraft,
  snapshotTarget,
}: {
  applyPreview: (params: {
    readonly url: string;
    readonly html: string;
  }) => void;
  clearPending: (url: string) => void;
  closeCommentMode: () => void;
  display: ArtifactDisplay;
  markPending: (url: string) => void;
  pendingUrl: string | null;
  publishingUrl: string | null;
  previewHtmlByUrl: Readonly<Record<string, string>>;
  saveDraft: (args: {
    readonly html: string;
    readonly threadId: string;
    readonly url: string;
  }) => void;
  snapshotTarget: { readonly threadId: string; readonly url: string } | null;
}) {
  const status =
    display.kind === "html" &&
    (pendingUrl === display.url || publishingUrl === display.url)
      ? ("working" as const)
      : undefined;
  const previewHtml =
    display.kind === "html" ? previewHtmlByUrl[display.url] : undefined;
  return {
    apply: (draft: HtmlDomEditDraft) => {
      // Persist the generated draft (fire-and-forget) so it survives navigation.
      // Style edits carry no comments and publish immediately, so they skip the
      // save and let publish success clear any existing snapshot.
      if (snapshotTarget && draft.comments.length > 0) {
        saveDraft({ ...snapshotTarget, html: draft.html });
      }
      applyPreview({ url: display.url, html: draft.html });
      closeCommentMode();
    },
    fail: () => {
      clearPending(display.url);
    },
    start: () => {
      markPending(display.url);
    },
    previewHtml,
    snapshotTarget,
    status,
  };
}

function createHtmlStyleEditApplyAction({
  display,
  htmlEditState,
  pageSignal,
  publishPreviewDraft,
}: {
  display: ArtifactDisplay;
  htmlEditState: ReturnType<typeof createHtmlEditState>;
  pageSignal: AbortSignal;
  publishPreviewDraft: (
    args:
      | string
      | {
          readonly threadId?: string;
          readonly url: string;
        },
    signal: AbortSignal,
  ) => Promise<void>;
}) {
  if (display.kind !== "html") {
    return undefined;
  }
  return async (html: string) => {
    htmlEditState.apply({
      comments: [],
      editRequestId: crypto.randomUUID(),
      html,
    });
    await publishPreviewDraft(
      htmlEditState.snapshotTarget ?? display.url,
      pageSignal,
    );
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
  editing,
  fullscreen,
}: {
  children: ReactNode;
  editing: boolean;
  fullscreen: boolean;
}) {
  return (
    <div
      className={cn(
        fullscreen
          ? cn(
              ARTIFACT_FULLSCREEN_SHELL_CLASSNAME,
              editing
                ? ARTIFACT_FULLSCREEN_EDIT_LAYER_CLASSNAME
                : ARTIFACT_FULLSCREEN_DEFAULT_LAYER_CLASSNAME,
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
  imageEditActive,
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
  imageEditActive: boolean;
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
        imageEditActive={imageEditActive}
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
  imageEditActive,
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
  imageEditActive: boolean;
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
  const hideArtifactActions = htmlEditActive || imageEditActive;
  const htmlExitAction =
    htmlState === "editing" && onExitHtmlEdit ? onExitHtmlEdit : undefined;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {url && (
        <>
          {!hideArtifactActions && (
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
      {htmlExitAction ? (
        <ArtifactExitHtmlEditAction onClick={htmlExitAction} />
      ) : compactActions ? (
        <ArtifactMoreActions onClose={onClose} />
      ) : (
        <ArtifactCloseAction onClose={onClose} />
      )}
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
    <ArtifactActionTooltip label="Exit editing">
      <button
        type="button"
        onClick={onClick}
        aria-label="Exit editing"
        data-testid="artifact-sidebar-exit-html-edit"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <IconX size={16} />
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
  htmlEditStatus,
  htmlPreviewHtml,
  htmlCommentMode,
  imageNavigation,
  onCloseHtmlCommentMode,
  onApplyHtmlEditDraft,
  onApplyHtmlStyleEdits,
  onHtmlEditRequestFailed,
  onHtmlEditRequestStarted,
  pageSignal,
  threadId,
}: {
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  htmlEditStatus?: "working";
  htmlPreviewHtml?: string;
  htmlCommentMode: boolean;
  imageNavigation?: ArtifactImageNavigationActions;
  onCloseHtmlCommentMode: () => void;
  onApplyHtmlEditDraft?: (draft: HtmlDomEditDraft) => void | Promise<void>;
  onApplyHtmlStyleEdits?: (html: string) => Promise<void>;
  onHtmlEditRequestFailed?: () => void;
  onHtmlEditRequestStarted?: () => void;
  pageSignal: AbortSignal;
  threadId?: string;
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
    return (
      <ArtifactImageBodyDispatch
        imageNavigation={imageNavigation}
        url={url}
        filename={filename}
        pageSignal={pageSignal}
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
    if (kind === "html" && artifactKind === "hosted-site" && htmlCommentMode) {
      return (
        <HtmlDomCommentEditor
          key={url}
          filename={filename}
          onApplyEditDraft={onApplyHtmlEditDraft}
          onApplyStyleEdits={onApplyHtmlStyleEdits}
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
        threadId={threadId}
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

function ArtifactImageBodyDispatch({
  imageNavigation,
  url,
  filename,
  pageSignal,
}: {
  imageNavigation?: ArtifactImageNavigationActions;
  url: string;
  filename: string;
  pageSignal: AbortSignal;
}) {
  const editMode = useGet(artifactImageEditMode$);
  const features = useLastResolved(featureSwitch$);
  const imageEditEnabled = Boolean(features?.[FeatureSwitchKey.ImageEditing]);
  if (editMode && imageEditEnabled) {
    return (
      <ArtifactImageEditBody
        imageNavigation={imageNavigation}
        url={url}
        filename={filename}
        pageSignal={pageSignal}
      />
    );
  }
  return (
    <ArtifactImageBody
      imageNavigation={imageNavigation}
      url={url}
      filename={filename}
    />
  );
}

function ArtifactImageBody({
  imageNavigation,
  url,
  filename,
}: {
  imageNavigation?: ArtifactImageNavigationActions;
  url: string;
  filename: string;
}) {
  const fullscreen = useGet(artifactFullscreen$);
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

const IMAGE_STYLE_TRANSFER_TEMPLATES = [
  {
    id: "warm-film",
    label: "Warm film",
    description: "Soft grain and golden-hour color.",
    prompt:
      "Warm analog film look with soft grain, golden-hour color, gentle contrast and natural skin tones.",
    thumbnailClassName:
      "bg-[linear-gradient(180deg,#fbbf24_0_48%,#78350f_49%_70%,#fef3c7_71%)] before:absolute before:left-2 before:top-2 before:h-3 before:w-3 before:rounded-full before:bg-[#fff7cc] before:shadow-[18px_20px_0_4px_rgba(146,64,14,.65)] after:absolute after:inset-0 after:bg-[repeating-linear-gradient(90deg,rgba(255,255,255,.3)_0_1px,transparent_1px_7px)]",
  },
  {
    id: "ink-wash",
    label: "Ink wash",
    description: "Monochrome brush texture.",
    prompt:
      "Elegant black ink wash illustration with subtle paper texture, expressive brush edges and preserved subject detail.",
    thumbnailClassName:
      "bg-[linear-gradient(180deg,#f8fafc,#e5e7eb)] before:absolute before:inset-x-1 before:bottom-2 before:h-7 before:bg-[linear-gradient(135deg,transparent_0_18%,#111827_19%_40%,transparent_41%),linear-gradient(45deg,transparent_0_24%,rgba(17,24,39,.72)_25%_58%,transparent_59%)] after:absolute after:inset-0 after:bg-[radial-gradient(circle_at_28%_58%,rgba(17,24,39,.4)_0_8%,transparent_9%),linear-gradient(116deg,transparent_0_53%,rgba(17,24,39,.72)_54%_60%,transparent_61%)]",
  },
  {
    id: "clay",
    label: "Clay",
    description: "Matte 3D hand-crafted form.",
    prompt:
      "Matte clay 3D render style with soft studio lighting, rounded hand-crafted forms and tactile surface detail.",
    thumbnailClassName:
      "bg-[linear-gradient(180deg,#fed7aa,#fdba74)] before:absolute before:left-2 before:top-3 before:h-6 before:w-6 before:rounded-full before:bg-[radial-gradient(circle_at_32%_24%,#ffedd5,#fb923c_58%,#c2410c)] before:shadow-[13px_8px_0_-3px_rgba(234,88,12,.55),10px_-2px_0_-7px_#9a3412] after:absolute after:left-3 after:bottom-2 after:h-2 after:w-8 after:rounded-full after:bg-[#9a3412]/25 after:blur-sm",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    description: "Light pigment and paper bloom.",
    prompt:
      "Delicate watercolor painting with translucent pigment, clean paper texture, soft edges and airy highlights.",
    thumbnailClassName:
      "bg-[#f8fafc] before:absolute before:inset-1 before:bg-[radial-gradient(circle_at_42%_34%,rgba(56,189,248,.55)_0_18%,transparent_38%),radial-gradient(circle_at_61%_50%,rgba(244,114,182,.48)_0_16%,transparent_34%),radial-gradient(circle_at_35%_62%,rgba(134,239,172,.55)_0_17%,transparent_36%)] before:blur-[1px] after:absolute after:left-5 after:top-3 after:h-8 after:w-4 after:rounded-full after:border-l-2 after:border-b-2 after:border-[#65a30d]/60 after:rotate-[-28deg]",
  },
  {
    id: "illustration-soft-vector",
    label: "Soft Vector",
    description: "Rounded shapes and gentle gradients.",
    prompt:
      "Soft Vector illustration template style with clean rounded vector shapes, gentle gradients, tidy negative space and polished editorial composition.",
    previewImage: illustrationTemplatePreviewImage("soft-vector"),
    thumbnailClassName:
      "bg-[#eef2ff] before:absolute before:left-2 before:top-2 before:h-5 before:w-7 before:rounded-full before:bg-[#93c5fd] after:absolute after:bottom-2 after:right-2 after:h-7 after:w-5 after:rounded-full after:bg-[#f9a8d4]",
  },
  {
    id: "illustration-grain-poster",
    label: "Grain Poster",
    description: "Graphic blocks with print texture.",
    prompt:
      "Grain Poster illustration template style with bold simplified forms, poster-like color blocks, tactile print grain and crisp graphic silhouettes.",
    previewImage: illustrationTemplatePreviewImage("grain-poster"),
    thumbnailClassName:
      "bg-[#fef3c7] before:absolute before:inset-2 before:bg-[linear-gradient(135deg,#ef4444_0_42%,#111827_43%_58%,#22c55e_59%)] after:absolute after:inset-0 after:bg-[radial-gradient(circle,rgba(17,24,39,.22)_0_1px,transparent_1px)] after:bg-[length:5px_5px]",
  },
  {
    id: "illustration-sunlit-gouache",
    label: "Sunlit Gouache",
    description: "Warm painted light and soft texture.",
    prompt:
      "Sunlit Gouache illustration template style with warm painted light, soft hand-rendered edges, gentle texture and calm storybook atmosphere.",
    previewImage: illustrationTemplatePreviewImage("sunlit-gouache"),
    thumbnailClassName:
      "bg-[#fef9c3] before:absolute before:left-1.5 before:top-1.5 before:h-6 before:w-6 before:rounded-full before:bg-[#facc15]/80 after:absolute after:bottom-2 after:right-1.5 after:h-6 after:w-8 after:rounded-t-full after:bg-[#86efac]",
  },
  {
    id: "illustration-notion",
    label: "Notion Illustration",
    description: "Minimal friendly monochrome linework.",
    prompt:
      "Notion Illustration template style with minimal friendly linework, soft monochrome shading, quiet whitespace and simple cozy everyday details.",
    previewImage: illustrationTemplatePreviewImage("notion-illustration"),
    thumbnailClassName:
      "bg-[#f8fafc] before:absolute before:left-2 before:top-2 before:h-6 before:w-6 before:rounded-full before:border-2 before:border-[#111827] after:absolute after:bottom-2 after:right-2 after:h-5 after:w-7 after:rounded-sm after:border-2 after:border-[#111827]",
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "Crisp lighting and polished finish.",
    prompt:
      "Premium editorial campaign style with crisp lighting, restrained contrast, clean color grading and polished detail.",
    thumbnailClassName:
      "bg-[linear-gradient(180deg,#f8fafc,#e2e8f0)] before:absolute before:left-2 before:top-2 before:h-8 before:w-6 before:bg-[linear-gradient(180deg,#0f172a_0_50%,#f8fafc_51%_62%,#ef4444_63%)] before:shadow-[16px_0_0_-4px_#cbd5e1] after:absolute after:right-2 after:top-2 after:h-2 after:w-5 after:bg-[#0f172a]",
  },
  {
    id: "neon-noir",
    label: "Neon noir",
    description: "Cinematic glow and rain-slick contrast.",
    prompt:
      "Cinematic neon noir style with saturated city lights, glossy reflections, moody shadows and high-contrast color grading.",
    thumbnailClassName:
      "bg-[linear-gradient(180deg,#020617_0_64%,#172554_65%)] before:absolute before:left-2 before:top-2 before:h-7 before:w-2 before:bg-[#22d3ee] before:shadow-[8px_5px_0_#a855f7,17px_0_0_#f43f5e,26px_9px_0_#38bdf8] after:absolute after:inset-x-1 after:bottom-2 after:h-2 after:bg-[linear-gradient(90deg,transparent,#22d3ee,#a855f7,#f43f5e,transparent)] after:blur-sm",
  },
  {
    id: "studio-product",
    label: "Studio product",
    description: "Clean commercial lighting.",
    prompt:
      "High-end commercial product photography style with clean studio lighting, crisp material detail, controlled shadows and polished realism.",
    thumbnailClassName:
      "bg-[radial-gradient(circle_at_50%_16%,#ffffff_0_14%,#e2e8f0_42%,#cbd5e1)] before:absolute before:left-[18px] before:top-2 before:h-7 before:w-4 before:rounded-md before:bg-[linear-gradient(180deg,#f8fafc,#64748b)] before:shadow-[0_0_0_1px_rgba(15,23,42,.12)] after:absolute after:left-3 after:bottom-2 after:h-2 after:w-7 after:rounded-full after:bg-black/10 after:blur-sm",
  },
  {
    id: "anime-cel",
    label: "Anime cel",
    description: "Clean linework and bold color.",
    prompt:
      "Modern anime cel-shaded style with clean expressive linework, flat vibrant color blocks, soft gradients and preserved character detail.",
    thumbnailClassName:
      "bg-[#dbeafe] before:absolute before:left-2 before:top-2 before:h-7 before:w-7 before:rounded-full before:border-2 before:border-[#111827] before:bg-[radial-gradient(circle_at_34%_44%,#111827_0_7%,transparent_8%),radial-gradient(circle_at_66%_44%,#111827_0_7%,transparent_8%),linear-gradient(180deg,#f9a8d4_0_38%,#fde68a_39%)] after:absolute after:left-2 after:top-1 after:h-4 after:w-7 after:rounded-t-full after:bg-[#2563eb]",
  },
  {
    id: "risograph",
    label: "Risograph",
    description: "Ink grain and offset layers.",
    prompt:
      "Risograph print style with limited spot colors, visible ink grain, slight registration offsets and tactile poster texture.",
    thumbnailClassName:
      "bg-[#fef3c7] before:absolute before:left-2 before:top-2 before:h-8 before:w-7 before:bg-[radial-gradient(circle_at_50%_32%,#ef4444_0_22%,transparent_23%),linear-gradient(180deg,transparent_0_42%,#22c55e_43%)] before:opacity-80 after:absolute after:inset-0 after:bg-[radial-gradient(circle,#111827_0_1px,transparent_1px)] after:bg-[length:5px_5px] after:opacity-25",
  },
  {
    id: "vintage-comic",
    label: "Vintage comic",
    description: "Halftone dots and bold inks.",
    prompt:
      "Vintage comic book style with bold ink outlines, halftone dot shading, saturated print colors and dramatic panel lighting.",
    thumbnailClassName:
      "bg-[#fde047] before:absolute before:inset-1 before:border-2 before:border-[#111827] before:bg-[radial-gradient(circle_at_50%_48%,#f8fafc_0_18%,#ef4444_19%_36%,transparent_37%),linear-gradient(135deg,#facc15,#ef4444)] after:absolute after:inset-0 after:bg-[radial-gradient(circle,#111827_0_1px,transparent_1px)] after:bg-[length:5px_5px] after:opacity-35",
  },
  {
    id: "paper-cut",
    label: "Paper cut",
    description: "Layered edges and soft shadows.",
    prompt:
      "Layered paper cutout illustration style with crisp paper edges, subtle fibers, dimensional shadows and handcrafted composition.",
    thumbnailClassName:
      "bg-[#ecfeff] before:absolute before:inset-x-1 before:bottom-2 before:h-7 before:bg-[radial-gradient(circle_at_24%_28%,#ffffff_0_11%,transparent_12%),linear-gradient(135deg,transparent_0_32%,#14b8a6_33%_61%,transparent_62%),linear-gradient(45deg,transparent_0_38%,#f9a8d4_39%_72%,transparent_73%)] before:drop-shadow-sm after:absolute after:left-3 after:top-2 after:h-3 after:w-3 after:rounded-full after:bg-[#facc15]",
  },
] as const;
const IMAGE_EDIT_UPLOAD_ACCEPT =
  "image/avif,image/bmp,image/gif,image/jpeg,image/png,image/webp";

type ImageStyleTransferTemplateId =
  (typeof IMAGE_STYLE_TRANSFER_TEMPLATES)[number]["id"];
type ImageStyleTransferTemplate =
  (typeof IMAGE_STYLE_TRANSFER_TEMPLATES)[number];

function illustrationTemplatePreviewImage(slug: string): string {
  const item = ILLUSTRATION_TEMPLATE_ITEMS.find((template) => {
    return template.slug === slug;
  });
  if (!item) {
    throw new Error(`Missing illustration template: ${slug}`);
  }
  return item.cardPreviewImage ?? item.previewImage;
}

function ImageStyleTemplateVisual({
  template,
}: {
  template: ImageStyleTransferTemplate;
}) {
  return (
    <span
      className={cn(
        "relative h-12 w-12 shrink-0 overflow-hidden rounded-md border border-border/70",
        template.thumbnailClassName,
      )}
      aria-hidden="true"
    >
      {"previewImage" in template ? (
        <img
          src={template.previewImage}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          data-testid={`image-edit-style-template-preview-${template.id}`}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
    </span>
  );
}

function ImageStyleTemplateOption({
  defaultChecked,
  template,
}: {
  defaultChecked: boolean;
  template: ImageStyleTransferTemplate;
}) {
  return (
    <label
      className="group relative flex min-h-16 cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-background p-1.5 pr-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:checked]:shadow-[0_0_0_3px_hsl(var(--primary)/0.1)]"
      data-testid={`image-edit-style-template-${template.id}`}
    >
      <input
        type="radio"
        name="styleTemplate"
        value={template.id}
        defaultChecked={defaultChecked}
        className="peer sr-only"
      />
      <ImageStyleTemplateVisual template={template} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground">
          {template.label}
        </span>
        <span className="block truncate text-[11px] leading-4 text-muted-foreground">
          {template.description}
        </span>
      </span>
      <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary opacity-0 transition-opacity group-has-[:checked]:opacity-100" />
    </label>
  );
}

function ImageStyleTemplateList() {
  const defaultTemplateId = IMAGE_STYLE_TRANSFER_TEMPLATES[0].id;
  return (
    <div className="mt-2 grid max-h-72 gap-1.5 overflow-y-auto pr-1">
      {IMAGE_STYLE_TRANSFER_TEMPLATES.map((template) => {
        return (
          <ImageStyleTemplateOption
            key={template.id}
            defaultChecked={template.id === defaultTemplateId}
            template={template}
          />
        );
      })}
    </div>
  );
}

function imageStylePromptFromForm(form: HTMLFormElement): string {
  const data = new FormData(form);
  const customStyle = String(data.get("customStyle") ?? "").trim();
  if (customStyle) {
    return customStyle;
  }
  const templateId = String(
    data.get("styleTemplate") ?? "warm-film",
  ) as ImageStyleTransferTemplateId;
  const template =
    IMAGE_STYLE_TRANSFER_TEMPLATES.find((item) => {
      return item.id === templateId;
    }) ?? IMAGE_STYLE_TRANSFER_TEMPLATES[0];
  return template.prompt;
}

function ArtifactImageEditToolbarButton({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <ArtifactActionTooltip label={label} side="top">
      <span className="inline-flex">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-9 rounded-lg border-border/70 bg-gray-50 p-0 text-muted-foreground hover:bg-gray-100 hover:text-foreground"
          data-testid={testId}
          aria-label={label}
          title={label}
          onClick={onClick}
        >
          {icon}
        </Button>
      </span>
    </ArtifactActionTooltip>
  );
}

function ArtifactImageStyleTransferPopover({
  item,
  onApply,
}: {
  item: EditableImageCanvasItem;
  onApply: (stylePrompt: string, item: EditableImageCanvasItem) => void;
}) {
  const applyStyle = (form: HTMLFormElement) => {
    onApply(imageStylePromptFromForm(form), item);
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applyStyle(event.currentTarget);
  };

  return (
    <Popover modal={false}>
      <ArtifactActionTooltip label="Style Transfer" side="top">
        <span className="inline-flex">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-9 rounded-lg border-border/70 bg-gray-50 p-0 text-muted-foreground hover:bg-gray-100 hover:text-foreground data-[state=open]:bg-gray-100 data-[state=open]:text-foreground"
              data-testid="image-edit-style-transfer"
              aria-label="Style Transfer"
              title="Style Transfer"
            >
              <IconPalette size={18} stroke={1.8} />
            </Button>
          </PopoverTrigger>
        </span>
      </ArtifactActionTooltip>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={10}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        className="z-[10000] max-h-[min(620px,calc(100vh-120px))] w-[360px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border-border/70 p-3 shadow-lg"
        data-testid="image-edit-style-popover"
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <p className="text-sm font-bold text-foreground">Style Transfer</p>
          <ImageStyleTemplateList />
          <p className="px-0.5 text-xs font-semibold text-muted-foreground">
            Custom style
          </p>
          <textarea
            className="min-h-16 w-full resize-none rounded-md border border-border/70 bg-background px-2.5 py-2 text-xs leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-foreground/30"
            name="customStyle"
            placeholder="Describe a custom style..."
            data-testid="image-edit-style-custom-input"
          />
          <PopoverClose asChild>
            <Button
              type="button"
              className="h-8 w-full rounded-md text-sm font-medium"
              data-testid="image-edit-apply-style"
              onClick={(event) => {
                if (event.currentTarget.form) {
                  applyStyle(event.currentTarget.form);
                }
              }}
            >
              Apply style
            </Button>
          </PopoverClose>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ArtifactImageEditShareMenu({ disabled }: { disabled: boolean }) {
  return (
    <DropdownMenu>
      <ArtifactActionTooltip label="Share" side="top">
        <span className="inline-flex">
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-9 rounded-lg border-border/70 bg-gray-50 p-0 text-muted-foreground hover:bg-gray-100 hover:text-foreground data-[state=open]:bg-gray-100 data-[state=open]:text-foreground"
              aria-label="Share image"
              disabled={disabled}
              data-testid="image-edit-share"
            >
              <IconShare size={18} stroke={1.8} />
            </Button>
          </DropdownMenuTrigger>
        </span>
      </ArtifactActionTooltip>
      <DropdownMenuContent align="center" className="w-44">
        <DropdownMenuItem disabled data-testid="image-edit-share-x">
          <IconBrandX size={14} stroke={1.6} />
          Share to X
        </DropdownMenuItem>
        <DropdownMenuItem disabled data-testid="image-edit-share-instagram">
          <IconBrandInstagram size={14} stroke={1.6} />
          Share to Instagram
        </DropdownMenuItem>
        <DropdownMenuItem disabled data-testid="image-edit-share-slack">
          <IconBrandSlack size={14} stroke={1.6} />
          Share to Slack
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Coming soon</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactImageEditSelectionToolbar({
  item,
  onDelete,
  onDownload,
  onOperation,
}: {
  item: EditableImageCanvasItem;
  onDelete: (item: EditableImageCanvasItem) => void;
  onDownload: (item: EditableImageCanvasItem) => void;
  onOperation: (
    operation: ImageEditOperation,
    item: EditableImageCanvasItem,
    stylePrompt?: string,
  ) => void;
}) {
  return (
    <div
      data-testid="image-edit-toolbar"
      className="flex w-max shrink-0 items-center gap-2 rounded-2xl border border-border/70 bg-gray-50/95 px-2 py-2 shadow-lg backdrop-blur"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <ArtifactImageEditToolbarButton
        icon={<IconBackground size={18} stroke={1.8} />}
        label="Remove background"
        onClick={() => {
          onOperation("removeBackground", item);
        }}
        testId="image-edit-remove-background"
      />
      <ArtifactImageEditToolbarButton
        icon={<IconSparkles size={18} stroke={1.8} />}
        label="Enhance"
        onClick={() => {
          onOperation("enhance", item);
        }}
        testId="image-edit-enhance"
      />
      <ArtifactImageStyleTransferPopover
        item={item}
        onApply={(stylePrompt, selectedItem) => {
          onOperation("styleTransfer", selectedItem, stylePrompt);
        }}
      />
      <ArtifactActionTooltip label="Delete" side="top">
        <span className="inline-flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 w-9 rounded-lg border-border/70 bg-gray-50 p-0 text-muted-foreground hover:bg-gray-100 hover:text-foreground"
            data-testid="image-edit-delete"
            aria-label="Delete image"
            title="Delete"
            onClick={() => {
              onDelete(item);
            }}
          >
            <IconTrash size={18} stroke={1.8} />
          </Button>
        </span>
      </ArtifactActionTooltip>
      <ArtifactImageEditShareMenu disabled={false} />
      <ArtifactActionTooltip label="Download" side="top">
        <span className="inline-flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 w-9 rounded-lg border-border/70 bg-gray-50 p-0 text-muted-foreground hover:bg-gray-100 hover:text-foreground"
            data-testid="image-edit-download"
            aria-label="Download"
            title="Download"
            onClick={() => {
              onDownload(item);
            }}
          >
            <IconDownload size={18} stroke={1.8} />
          </Button>
        </span>
      </ArtifactActionTooltip>
    </div>
  );
}

function ArtifactImageEditUploadFileControl({
  disabled,
  onSelectFiles,
  uploading,
}: {
  disabled: boolean;
  onSelectFiles: (files: readonly File[]) => void;
  uploading: boolean;
}) {
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) {
      onSelectFiles(files);
    }
  };

  return (
    <>
      <label
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
          disabled
            ? "cursor-not-allowed opacity-45"
            : "cursor-pointer hover:bg-muted hover:text-foreground",
        )}
        htmlFor="image-edit-upload-input-control"
        data-testid="image-edit-upload-local"
        aria-label="Upload from computer"
        title="Upload from computer"
      >
        {uploading ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconPaperclip size={16} stroke={1.6} />
        )}
      </label>
      <input
        id="image-edit-upload-input-control"
        type="file"
        accept={IMAGE_EDIT_UPLOAD_ACCEPT}
        multiple
        disabled={disabled}
        className="hidden"
        data-testid="image-edit-upload-input"
        onChange={handleFileChange}
      />
    </>
  );
}

function ArtifactImageEditUploadLinkForm({
  disabled,
  onSelectLink,
}: {
  disabled: boolean;
  onSelectLink: (url: string) => void;
}) {
  const [imageUrl, setImageUrl] = useState("");
  const linkHasValue = imageUrl.trim().length > 0;
  const handleLinkSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = imageUrl.trim();
    if (!value) {
      return;
    }
    if (!URL.canParse(value)) {
      toast.error("Enter a valid image link");
      return;
    }
    onSelectLink(new URL(value).toString());
    setImageUrl("");
  };

  return (
    <form
      className="flex h-8 min-w-0 flex-1 items-center gap-1 border-l border-border/70 pl-2"
      onSubmit={handleLinkSubmit}
    >
      <IconLink
        size={15}
        stroke={1.7}
        className="shrink-0 text-muted-foreground"
      />
      <input
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45"
        name="imageUrl"
        placeholder="Paste link"
        type="url"
        value={imageUrl}
        disabled={disabled}
        data-testid="image-edit-upload-link-input"
        onChange={(event) => {
          setImageUrl(event.currentTarget.value);
        }}
      />
      {linkHasValue ? (
        <Button
          type="submit"
          size="icon"
          variant="ghost"
          className="h-7 w-7 rounded-md p-0 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          data-testid="image-edit-upload-link-add"
          aria-label="Add image link"
          title="Add image link"
        >
          <IconPlus size={16} stroke={1.8} />
        </Button>
      ) : null}
    </form>
  );
}

function ArtifactImageEditUploadMenu({
  disabled,
  onSelectFiles,
  onSelectLink,
  uploading,
}: {
  disabled: boolean;
  onSelectFiles: (files: readonly File[]) => void;
  onSelectLink: (url: string) => void;
  uploading: boolean;
}) {
  return (
    <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
      <Popover modal={false}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-lg border-border/70 bg-background/90 p-0 shadow-sm backdrop-blur hover:bg-muted"
            disabled={disabled}
            data-testid="image-edit-upload-menu"
            aria-label="Upload image"
            title="Upload image"
          >
            {uploading ? (
              <IconLoader2 size={16} className="animate-spin" />
            ) : (
              <IconUpload size={16} stroke={1.8} />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          sideOffset={8}
          className="z-[10000] w-56 p-1 shadow-lg"
          data-testid="image-edit-upload-popover"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <div className="flex items-center gap-1">
            <ArtifactImageEditUploadFileControl
              disabled={disabled}
              onSelectFiles={onSelectFiles}
              uploading={uploading}
            />
            <ArtifactImageEditUploadLinkForm
              disabled={disabled}
              onSelectLink={onSelectLink}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ArtifactImageEditBody({
  imageNavigation,
  url,
  filename,
  pageSignal,
}: {
  imageNavigation?: ArtifactImageNavigationActions;
  url: string;
  filename: string;
  pageSignal: AbortSignal;
}) {
  const fullscreen = useGet(artifactFullscreen$);
  const modalOpen = useGet(lightboxDialogVisible$);
  const imageUploading = useGet(imageEditUploading$);
  const runImageEdit = useSet(runImageEdit$);
  const deleteCanvasItem = useSet(deleteEditableImageCanvasItem$);
  const importCanvasImageUrl = useSet(importEditableImageCanvasImageUrl$);
  const uploadCanvasImage = useSet(uploadEditableImageCanvasImage$);
  const canvasSrc = publicAttachmentUrl(url);
  const canvasKey = editableImageArtifactCanvasKey(url);

  const onOperation = (
    operation: ImageEditOperation,
    item: EditableImageCanvasItem,
    stylePrompt?: string,
  ) => {
    detach(
      runImageEdit(
        {
          canvasKey,
          canvasSrc,
          operation,
          sourceItemId: item.id,
          stylePrompt,
          url: item.src,
        },
        pageSignal,
      ),
      Reason.DomCallback,
      "runImageEdit",
    );
  };
  const onDownload = (item: EditableImageCanvasItem) => {
    detach(
      downloadAttachmentUrl(item.src, pageSignal, filename),
      Reason.DomCallback,
      "downloadEditableImageCanvasItem",
    );
  };
  const onDelete = (item: EditableImageCanvasItem) => {
    deleteCanvasItem({
      itemId: item.id,
      key: canvasKey,
      src: canvasSrc,
    });
  };
  const onUploadFiles = (files: readonly File[]) => {
    detach(
      uploadCanvasImage({ canvasKey, canvasSrc }, files, pageSignal),
      Reason.DomCallback,
      "uploadEditableImageCanvasImage",
    );
  };
  const onUploadLink = (src: string) => {
    detach(
      importCanvasImageUrl({ canvasKey, canvasSrc }, src, pageSignal),
      Reason.DomCallback,
      "importEditableImageCanvasImageUrl",
    );
  };

  return (
    <ArtifactStageShell flush scrollable={false}>
      <ArtifactStageCard fillHeight>
        <div className="relative h-full min-h-0">
          <ArtifactSidebarImageNavigationKeydown
            fullscreen={fullscreen}
            modalOpen={modalOpen}
            navigation={imageNavigation}
          />
          <EditableArtifactImageCanvas
            src={canvasSrc}
            alt={filename}
            canvasKey={canvasKey}
            imageTestId="artifact-sidebar-body-image"
            canvasTestId="artifact-sidebar-image-edit-canvas"
            viewportKey={fullscreen ? "fullscreen" : "sidebar"}
            renderSelectionToolbar={(item) => {
              return (
                <ArtifactImageEditSelectionToolbar
                  item={item}
                  onDelete={onDelete}
                  onDownload={onDownload}
                  onOperation={onOperation}
                />
              );
            }}
          >
            {(controls) => {
              return (
                <>
                  <ArtifactImageZoomControls controls={controls} />
                  <ArtifactImageEditUploadMenu
                    disabled={imageUploading}
                    onSelectFiles={onUploadFiles}
                    onSelectLink={onUploadLink}
                    uploading={imageUploading}
                  />
                </>
              );
            }}
          </EditableArtifactImageCanvas>
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
  htmlEditStatus,
  htmlPreviewHtml,
  threadId,
}: {
  url: string;
  kind: "html" | "pdf";
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  htmlEditStatus?: "working";
  htmlPreviewHtml?: string;
  threadId?: string;
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
          // Remount on live<->draft switch: swapping `src`<->`srcDoc` on the
          // same iframe doesn't reliably reload it, leaving the original showing.
          // (draft->draft updates fine via the srcDoc attribute, so presence is
          // the only transition that needs a fresh element.)
          key={htmlPreviewHtml ? "draft" : "live"}
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
              detach(
                discardHtmlDomEditPreviewDraft({ threadId, url }, pageSignal),
                Reason.DomCallback,
                "discardHtmlDomEditPreviewDraft",
              );
            }}
            onPublish={() => {
              detach(
                publishHtmlDomEditPreviewDraft({ threadId, url }, pageSignal),
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
