import type { ChangeEvent, FormEvent, ReactNode } from "react";
import {
  IconArrowLeft,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconBackground,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconDots,
  IconEye,
  IconExternalLink,
  IconFolderPlus,
  IconLink,
  IconLoader2,
  IconMessageCircle,
  IconPalette,
  IconPencil,
  IconPointer2,
  IconSend2,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconWand,
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
import {
  artifactPreviewUrlsMatch,
  copyAttachmentLinkToClipboard,
} from "./zero-attachment-url.ts";
import { lightboxDialogVisible$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  artifactImageEditMode$,
  closeArtifactImageEdit$,
  imageEditUploading$,
  openArtifactImageEdit$,
  persistEditableImageCanvasSnapshot$,
  setImageEditSnapshotControllerRef$,
  type ImageEditRegionComment,
  type ImageEditRegion,
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
  addEditableImageCanvasRegionComment$,
  clearEditableImageCanvasRegionSelection$,
  deleteEditableImageCanvasItem$,
  type EditableImageCanvasItem,
  type EditableImageCanvasRegionComment,
  type EditableImageCanvasRegion,
  editableImageArtifactCanvasKey,
  editableImageCanvasRegionCommentsByKey$,
  editableImageCanvasRegionInstructionDraftByKey$,
  editableImageCanvasRegionSelectionActiveByKey$,
  removeEditableImageCanvasRegionComment$,
  setEditableImageCanvasRegionInstructionDraft$,
  startEditingEditableImageCanvasRegionComment$,
  startEditableImageCanvasRegionSelection$,
} from "../../signals/zero-page/zero-editable-image-canvas.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { ChatThreadSignals } from "../../signals/chat-page/chat-thread-signals.ts";
import type { ChatThreadArtifactFile } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ZERO_IMAGE_INTERPRET_MARKS_MAX_INSTRUCTION_LENGTH,
  ZERO_IMAGE_INTERPRET_MARKS_MAX_REGIONS,
} from "@vm0/api-contracts/contracts/zero-image-io-interpret-marks";
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
  const agentId = useGet(thread.agentId$);
  const messageGroups = useLastResolved(thread.messageImageGroups$, {
    equalityFn: equalMessageImageGroups,
  });
  const navigateArtifactSidebarImage = useSet(navigateArtifactSidebarImage$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
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
  const closeImageEditMode = useSet(closeArtifactImageEdit$);
  const markHtmlDomEditPending = useSet(markHtmlDomEditPending$);
  const openHtmlCommentMode = useSet(openArtifactHtmlEditMode$);
  const openImageEditMode = useSet(openArtifactImageEdit$);
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
  const editImage =
    display.kind === "image" && imageEditEnabled && !imageEditActive
      ? () => {
          resetZoomableImageCanvasZoom(
            zoomableArtifactImageKey(
              "artifact-sidebar",
              display.url,
              fullscreen ? "fullscreen" : "sidebar",
            ),
          );
          openImageEditMode({ fullscreen, url: display.url });
        }
      : undefined;

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
      closeImageEditMode={closeImageEditMode}
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
      onEditImage={editImage}
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

type ArtifactSidebarResolvedContentProps = {
  readonly closeHtmlCommentMode: () => void;
  readonly closeImageEditMode: () => void;
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
  readonly onEditImage?: () => void;
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
};

function ArtifactSidebarResolvedContent({
  closeHtmlCommentMode,
  closeImageEditMode,
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
  onEditImage,
  openHtmlCommentMode,
  openPresentationEditor,
  pageSignal,
  publishHtmlDomEditPreviewDraft,
  resetZoomableImageCanvasZoom,
  syncTarget,
  threadId,
  toggleFullscreen,
}: ArtifactSidebarResolvedContentProps) {
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
  const exitImageEdit = imageEditActive ? closeImageEditMode : undefined;

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
        onEditImage={onEditImage}
        onEditPresentation={editPresentation}
        onEditHtml={editHtml}
        onExitHtmlEdit={exitHtmlEdit}
        onExitImageEdit={exitImageEdit}
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
  htmlState,
  imageEditActive,
  onBack,
  onEditHtml,
  onEditImage,
  onEditPresentation,
  onExitHtmlEdit,
  onExitImageEdit,
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
  onEditImage?: () => void;
  onEditPresentation?: () => void;
  onExitHtmlEdit?: () => void;
  onExitImageEdit?: () => void;
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
        onEditImage={onEditImage}
        onEditPresentation={onEditPresentation}
        onExitHtmlEdit={onExitHtmlEdit}
        onExitImageEdit={onExitImageEdit}
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
  onEditImage,
  onEditPresentation,
  onExitHtmlEdit,
  onExitImageEdit,
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
  onEditImage?: () => void;
  onEditPresentation?: () => void;
  onExitHtmlEdit?: () => void;
  onExitImageEdit?: () => void;
  onToggleFullscreen: () => void;
  syncTarget?: ArtifactDownloadSyncTarget;
  title: string;
  url?: string;
}) {
  const features = useLastResolved(featureSwitch$);
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
            <ArtifactSidebarPreviewActions
              artifactKind={artifactKind}
              kind={kind}
              onEditImage={onEditImage}
              onEditPresentation={onEditPresentation}
              syncTarget={syncTarget}
              title={title}
              url={url}
            />
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
      ) : onExitImageEdit ? (
        <ArtifactExitImageEditAction onClick={onExitImageEdit} />
      ) : compactActions ? (
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
  onEditImage,
  onEditPresentation,
  syncTarget,
  title,
  url,
}: {
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  kind?: ArtifactKindForBody;
  onEditImage?: () => void;
  onEditPresentation?: () => void;
  syncTarget?: ArtifactDownloadSyncTarget;
  title: string;
  url: string;
}) {
  const showPresentationEdit =
    artifactKind === "presentation-html" && onEditPresentation !== undefined;
  const showImageEdit = kind === "image" && onEditImage !== undefined;

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
      {showPresentationEdit && (
        <>
          <ArtifactEditPresentationAction onClick={onEditPresentation} />
          <ArtifactActionSeparator />
        </>
      )}
      {showImageEdit && (
        <>
          <ArtifactEditImageAction onClick={onEditImage} />
          <ArtifactActionSeparator />
        </>
      )}
    </>
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

function ArtifactEditImageAction({ onClick }: { onClick: () => void }) {
  return (
    <ArtifactActionTooltip label="Edit image">
      <button
        type="button"
        onClick={onClick}
        aria-label="Edit image"
        data-testid="artifact-sidebar-edit-image"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <IconWand size={16} stroke={1.5} />
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

function ArtifactExitImageEditAction({ onClick }: { onClick: () => void }) {
  return (
    <ArtifactActionTooltip label="Exit image editing">
      <button
        type="button"
        onClick={onClick}
        aria-label="Exit image editing"
        data-testid="artifact-sidebar-exit-image-edit"
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
    id: "illustration",
    label: "Illustration",
    description: "Clean vector shapes.",
    prompt:
      "Clean vector illustration style with simple friendly shapes, crisp contours, balanced color blocks and polished editorial composition.",
    thumbnail: "illustration",
  },
  {
    id: "anime-cell",
    label: "Anime cell",
    description: "Cel color.",
    prompt:
      "Modern anime cel-shaded style with clean expressive linework, flat vibrant color blocks, soft gradients and preserved character detail.",
    thumbnail: "animeCell",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    description: "Pigment bloom.",
    prompt:
      "Delicate watercolor painting with translucent pigment, clean paper texture, soft edges and airy highlights.",
    thumbnail: "watercolor",
  },
  {
    id: "risograph",
    label: "Risograph",
    description: "Layered ink.",
    prompt:
      "Risograph print style with limited spot colors, visible ink grain, slight registration offsets and tactile poster texture.",
    thumbnail: "risograph",
  },
  {
    id: "papercut",
    label: "Papercut",
    description: "Layered paper.",
    prompt:
      "Layered paper cutout illustration style with crisp paper edges, subtle fibers, dimensional shadows and handcrafted composition.",
    thumbnail: "papercut",
  },
  {
    id: "studio-production",
    label: "Studio production",
    description: "Studio lighting.",
    prompt:
      "Polished studio production style with soft commercial lighting, controlled shadows, clean backdrop, crisp detail and premium finished presentation.",
    thumbnail: "studioProduction",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Workspace illustration.",
    prompt:
      "Notion-style workspace illustration with clean black linework, simple geometric props, quiet whitespace and soft supporting color blocks.",
    thumbnail: "notion",
  },
  {
    id: "ink-wash",
    label: "Ink wash",
    description: "Ink texture.",
    prompt:
      "Elegant black ink wash illustration with subtle paper texture, expressive brush edges and preserved subject detail.",
    thumbnail: "inkWash",
  },
  {
    id: "clay",
    label: "Clay",
    description: "Clay form.",
    prompt:
      "Matte clay 3D render style with soft studio lighting, rounded hand-crafted forms and tactile surface detail.",
    thumbnail: "clay",
  },
] as const;
const IMAGE_EDIT_UPLOAD_ACCEPT =
  "image/avif,image/bmp,image/gif,image/jpeg,image/png,image/webp";

type ImageStyleTransferTemplate =
  (typeof IMAGE_STYLE_TRANSFER_TEMPLATES)[number];
type ImageStyleTransferThumbnail =
  (typeof IMAGE_STYLE_TRANSFER_TEMPLATES)[number]["thumbnail"];

function InkWashStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="#f8fafc"
        stroke="#d7dee8"
        strokeWidth="2"
      />
      <circle cx="30" cy="29" r="9" fill="#111827" opacity=".84" />
      <path
        d="M18 72l25-34 16 18 20-30"
        fill="none"
        stroke="#111827"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 72l25-34 16 18 20-30"
        fill="none"
        stroke="#4b5563"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".52"
      />
      <path
        d="M27 78c17-28 33-47 49-61"
        fill="none"
        stroke="#111827"
        strokeWidth="6"
        strokeLinecap="round"
        opacity=".22"
      />
    </svg>
  );
}

function ClayStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <defs>
        <radialGradient id="image-style-clay-main" cx=".35" cy=".28" r=".7">
          <stop offset="0" stopColor="#fff1d4" />
          <stop offset=".25" stopColor="#ffbd76" />
          <stop offset=".78" stopColor="#ee7628" />
          <stop offset="1" stopColor="#bd4f1a" />
        </radialGradient>
        <linearGradient id="image-style-clay-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe2b6" />
          <stop offset="1" stopColor="#ffb064" />
        </linearGradient>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="url(#image-style-clay-bg)"
      />
      <path
        d="M18 70c15-24 29-33 47-32 10 1 16 7 19 14-7 13-17 23-31 27-13 4-25 0-35-9z"
        fill="url(#image-style-clay-main)"
      />
      <path
        d="M24 69c13-22 26-30 42-29"
        fill="none"
        stroke="#a74618"
        strokeWidth="6"
        strokeLinecap="round"
        opacity=".42"
      />
      <circle cx="33" cy="34" r="12" fill="#ffe5bd" />
      <ellipse cx="36" cy="51" rx="12" ry="7" fill="#fff2db" opacity=".45" />
    </svg>
  );
}

function WatercolorStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <defs>
        <filter id="image-style-watercolor-blur">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="#fbfdff"
        stroke="#d7dee8"
        strokeWidth="2"
      />
      <circle
        cx="34"
        cy="38"
        r="19"
        fill="#55c7f3"
        opacity=".55"
        filter="url(#image-style-watercolor-blur)"
      />
      <circle
        cx="35"
        cy="61"
        r="20"
        fill="#7ce6a2"
        opacity=".45"
        filter="url(#image-style-watercolor-blur)"
      />
      <circle
        cx="61"
        cy="52"
        r="18"
        fill="#ff75ac"
        opacity=".46"
        filter="url(#image-style-watercolor-blur)"
      />
      <path
        d="M18 70c18-28 34-34 60-38"
        fill="none"
        stroke="#7fae55"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M19 70c18-28 34-34 60-38"
        fill="none"
        stroke="#35a7e7"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity=".7"
      />
      <circle cx="30" cy="31" r="10" fill="#fff7c7" opacity=".8" />
    </svg>
  );
}

function AnimeCellStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <defs>
        <linearGradient id="image-style-anime-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dff4ff" />
          <stop offset="1" stopColor="#fff1b8" />
        </linearGradient>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="url(#image-style-anime-sky)"
        stroke="#1f2937"
        strokeWidth="2.5"
      />
      <path
        d="M18 70l25-34 16 18 20-30v46z"
        fill="#8fd3ff"
        stroke="#1f2937"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M43 36l16 18 20-30v46H59z" fill="#ffb6c8" />
      <path
        d="M18 70l25-34 16 18 20-30"
        fill="none"
        stroke="#1f2937"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="31"
        cy="29"
        r="9"
        fill="#ffd95a"
        stroke="#1f2937"
        strokeWidth="2.5"
      />
      <path
        d="M16 18h24"
        fill="none"
        stroke="#ffffff"
        strokeWidth="4"
        strokeLinecap="round"
        opacity=".78"
      />
    </svg>
  );
}

function RisographStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <defs>
        <pattern
          id="image-style-riso-dots"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1.5" cy="1.5" r="1.1" fill="#1f2937" opacity=".18" />
        </pattern>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="#fff7d6"
        stroke="#d7dee8"
        strokeWidth="2"
      />
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="url(#image-style-riso-dots)"
      />
      <circle cx="31" cy="30" r="11" fill="#ff4f8b" opacity=".82" />
      <circle cx="27" cy="33" r="11" fill="#ffd23f" opacity=".72" />
      <path
        d="M18 72l25-34 16 18 20-30"
        fill="none"
        stroke="#006d77"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".92"
      />
      <path
        d="M22 68l25-34 16 18 20-30"
        fill="none"
        stroke="#ff4f8b"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".72"
      />
      <path
        d="M16 76h62"
        fill="none"
        stroke="#ffd23f"
        strokeWidth="6"
        strokeLinecap="round"
        opacity=".72"
      />
    </svg>
  );
}

function PapercutStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <defs>
        <filter
          id="image-style-paper-shadow"
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
        >
          <feDropShadow
            dx="0"
            dy="2"
            stdDeviation="1.4"
            floodColor="#475569"
            floodOpacity=".24"
          />
        </filter>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="#fffaf0"
        stroke="#d7dee8"
        strokeWidth="2"
      />
      <circle
        cx="30"
        cy="31"
        r="10"
        fill="#ffd166"
        filter="url(#image-style-paper-shadow)"
      />
      <path
        d="M18 72l25-35 16 19 20-31v47z"
        fill="#8bd3dd"
        filter="url(#image-style-paper-shadow)"
      />
      <path
        d="M43 37l16 19 20-31v47H59z"
        fill="#f9a8d4"
        filter="url(#image-style-paper-shadow)"
      />
      <path
        d="M18 72l25-35 16 19 20-31"
        fill="none"
        stroke="#334155"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 75h65"
        fill="none"
        stroke="#facc15"
        strokeWidth="6"
        strokeLinecap="round"
        opacity=".55"
      />
    </svg>
  );
}

function NotionStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="#ffffff"
        stroke="#d7dee8"
        strokeWidth="2"
      />
      <rect
        x="18"
        y="18"
        width="22"
        height="15"
        rx="4"
        fill="#fde68a"
        opacity=".8"
      />
      <rect
        x="57"
        y="19"
        width="18"
        height="18"
        rx="5"
        fill="#bfdbfe"
        opacity=".82"
      />
      <rect
        x="56"
        y="59"
        width="20"
        height="13"
        rx="4"
        fill="#fecaca"
        opacity=".82"
      />
      <circle
        cx="30"
        cy="32"
        r="7"
        fill="#fbbf24"
        stroke="#111827"
        strokeWidth="2.5"
      />
      <path
        d="M18 70l25-34 16 18 20-30"
        fill="none"
        stroke="#111827"
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 71c8-7 17-8 27-4 10 4 20 3 31-5"
        fill="none"
        stroke="#111827"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity=".28"
      />
      <path
        d="M21 78h51"
        fill="none"
        stroke="#111827"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity=".36"
      />
    </svg>
  );
}

function IllustrationStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <defs>
        <linearGradient
          id="image-style-illustration-bg"
          x1="0"
          y1="0"
          x2="1"
          y2="1"
        >
          <stop offset="0" stopColor="#e0f2fe" />
          <stop offset="1" stopColor="#fff7ed" />
        </linearGradient>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="url(#image-style-illustration-bg)"
        stroke="#d7dee8"
        strokeWidth="2"
      />
      <circle cx="30" cy="31" r="10" fill="#facc15" />
      <path d="M18 72l25-34 16 18 20-30v46z" fill="#38bdf8" opacity=".92" />
      <path d="M43 38l16 18 20-30v46H59z" fill="#fb7185" opacity=".9" />
      <path
        d="M18 72l25-34 16 18 20-30"
        fill="none"
        stroke="#334155"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 72h62"
        fill="none"
        stroke="#22c55e"
        strokeWidth="6"
        strokeLinecap="round"
        opacity=".65"
      />
    </svg>
  );
}

function StudioProductionStyleThumbnail() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-full w-full">
      <defs>
        <radialGradient id="image-style-studio-light" cx=".5" cy=".22" r=".78">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".58" stopColor="#eef2f7" />
          <stop offset="1" stopColor="#cbd5e1" />
        </radialGradient>
        <linearGradient
          id="image-style-studio-card"
          x1="0"
          y1="0"
          x2="1"
          y2="1"
        >
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e2e8f0" />
        </linearGradient>
        <filter
          id="image-style-studio-shadow"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
        >
          <feDropShadow
            dx="0"
            dy="5"
            stdDeviation="3"
            floodColor="#0f172a"
            floodOpacity=".28"
          />
        </filter>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="10"
        fill="url(#image-style-studio-light)"
        stroke="#d7dee8"
        strokeWidth="2"
      />
      <ellipse cx="48" cy="74" rx="27" ry="7" fill="#0f172a" opacity=".18" />
      <g filter="url(#image-style-studio-shadow)">
        <rect
          x="21"
          y="22"
          width="54"
          height="43"
          rx="9"
          fill="url(#image-style-studio-card)"
        />
        <circle cx="34" cy="34" r="7" fill="#f8c14a" />
        <path
          d="M28 56l16-20 12 14 14-21"
          fill="none"
          stroke="#475569"
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M24 63h48"
          fill="none"
          stroke="#ffffff"
          strokeWidth="3"
          strokeLinecap="round"
          opacity=".8"
        />
      </g>
      <path
        d="M24 18h49"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        opacity=".9"
      />
    </svg>
  );
}

const IMAGE_STYLE_TRANSFER_THUMBNAILS = {
  animeCell: AnimeCellStyleThumbnail,
  clay: ClayStyleThumbnail,
  illustration: IllustrationStyleThumbnail,
  inkWash: InkWashStyleThumbnail,
  notion: NotionStyleThumbnail,
  papercut: PapercutStyleThumbnail,
  risograph: RisographStyleThumbnail,
  studioProduction: StudioProductionStyleThumbnail,
  watercolor: WatercolorStyleThumbnail,
} satisfies Record<ImageStyleTransferThumbnail, () => ReactNode>;

function ImageStyleTransferThumbnailSvg({
  thumbnail,
}: {
  thumbnail: ImageStyleTransferThumbnail;
}) {
  const Thumbnail = IMAGE_STYLE_TRANSFER_THUMBNAILS[thumbnail];
  return <Thumbnail />;
}

function ImageStyleTemplateVisual({
  template,
}: {
  template: ImageStyleTransferTemplate;
}) {
  return (
    <span
      className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-border/70 bg-background"
      aria-hidden="true"
      data-testid={`image-edit-style-template-preview-${template.id}`}
    >
      <ImageStyleTransferThumbnailSvg thumbnail={template.thumbnail} />
    </span>
  );
}

function ImageStyleTemplateOption({
  template,
}: {
  template: ImageStyleTransferTemplate;
}) {
  return (
    <label
      className="group relative flex min-h-[92px] cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-border/70 bg-muted/20 p-1.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:checked]:shadow-[0_0_0_3px_hsl(var(--primary)/0.1)]"
      data-testid={`image-edit-style-template-${template.id}`}
    >
      <input
        type="radio"
        name="styleMode"
        value={template.id}
        className="peer sr-only"
      />
      <ImageStyleTemplateVisual template={template} />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-bold leading-3 text-foreground">
          {template.label}
        </span>
        <span className="mt-0.5 block text-[10px] leading-3 text-muted-foreground">
          {template.description}
        </span>
      </span>
      <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary opacity-0 transition-opacity group-has-[:checked]:opacity-100" />
    </label>
  );
}

function ImageStyleTemplateList() {
  return (
    <div className="mt-2 grid grid-cols-3 gap-1.5">
      {IMAGE_STYLE_TRANSFER_TEMPLATES.map((template) => {
        return (
          <ImageStyleTemplateOption key={template.id} template={template} />
        );
      })}
    </div>
  );
}

function imageStylePromptFromForm(form: HTMLFormElement): string | null {
  const data = new FormData(form);
  const selectedMode = String(data.get("styleMode") ?? "");
  const customStyle = String(data.get("customStyle") ?? "").trim();
  if (selectedMode === "custom") {
    return customStyle || null;
  }
  const template = IMAGE_STYLE_TRANSFER_TEMPLATES.find((item) => {
    return item.id === selectedMode;
  });
  return template?.prompt ?? null;
}

function syncImageStyleApplyButton(form: HTMLFormElement): void {
  const button = form.querySelector('[data-testid="image-edit-apply-style"]');
  if (button instanceof HTMLButtonElement) {
    button.setAttribute(
      "aria-disabled",
      imageStylePromptFromForm(form) === null ? "true" : "false",
    );
  }
}

function ArtifactImageEditToolbarButton({
  active = false,
  grouped = false,
  icon,
  label,
  onClick,
  testId,
}: {
  active?: boolean;
  grouped?: boolean;
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
          className={cn(
            grouped
              ? "h-9 w-9 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-gray-100 hover:text-foreground"
              : "h-9 w-9 rounded-lg border-border/70 bg-gray-50 p-0 text-muted-foreground hover:bg-gray-100 hover:text-foreground",
            active &&
              "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
          )}
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
  grouped = false,
  item,
  onApply,
}: {
  grouped?: boolean;
  item: EditableImageCanvasItem;
  onApply: (stylePrompt: string, item: EditableImageCanvasItem) => void;
}) {
  const applyStyle = (form: HTMLFormElement) => {
    const stylePrompt = imageStylePromptFromForm(form);
    if (!stylePrompt) {
      return;
    }
    onApply(stylePrompt, item);
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
              className={cn(
                grouped
                  ? "h-9 w-9 rounded-none border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-gray-100 hover:text-foreground data-[state=open]:bg-gray-100 data-[state=open]:text-foreground"
                  : "h-9 w-9 rounded-lg border-border/70 bg-gray-50 p-0 text-muted-foreground hover:bg-gray-100 hover:text-foreground data-[state=open]:bg-gray-100 data-[state=open]:text-foreground",
              )}
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
        className="z-[10000] max-h-[min(620px,calc(100vh-120px))] w-[420px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border-border/70 p-3 shadow-lg"
        data-testid="image-edit-style-popover"
      >
        <form
          onChange={(event) => {
            syncImageStyleApplyButton(event.currentTarget);
          }}
          onSubmit={handleSubmit}
          className="space-y-3"
        >
          <p className="text-sm font-bold text-foreground">Style Transfer</p>
          <ImageStyleTemplateList />
          <label
            className="group block cursor-text rounded-lg border border-border/70 bg-muted/20 p-2 transition-colors hover:border-primary/40 hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:checked]:shadow-[0_0_0_3px_hsl(var(--primary)/0.1)]"
            data-testid="image-edit-style-custom-option"
          >
            <span className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                Custom style
              </span>
              <span className="h-2 w-2 rounded-full bg-primary opacity-0 transition-opacity group-has-[:checked]:opacity-100" />
            </span>
            <input
              type="radio"
              name="styleMode"
              value="custom"
              className="peer sr-only"
            />
            <textarea
              className="min-h-16 w-full resize-none rounded-md border border-border/70 bg-background px-2.5 py-2 text-xs leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-foreground/30"
              name="customStyle"
              placeholder="Describe a custom style..."
              data-testid="image-edit-style-custom-input"
              onFocus={(event) => {
                const form = event.currentTarget.form;
                const customStyleRadio = form?.querySelector(
                  'input[name="styleMode"][value="custom"]',
                );
                if (customStyleRadio instanceof HTMLInputElement) {
                  customStyleRadio.checked = true;
                }
                if (form) {
                  syncImageStyleApplyButton(form);
                }
              }}
              onChange={(event) => {
                const form = event.currentTarget.form;
                if (form) {
                  syncImageStyleApplyButton(form);
                }
              }}
            />
          </label>
          <PopoverClose asChild>
            <Button
              type="button"
              className="h-8 w-full rounded-md text-sm font-medium aria-disabled:pointer-events-none aria-disabled:opacity-50"
              data-testid="image-edit-apply-style"
              aria-disabled="true"
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (!form || imageStylePromptFromForm(form) === null) {
                  event.preventDefault();
                  return;
                }
                applyStyle(form);
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

function ArtifactImageEditDeleteButton({
  item,
  onDelete,
}: {
  item: EditableImageCanvasItem;
  onDelete: (item: EditableImageCanvasItem) => void;
}) {
  return (
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
  );
}

function ArtifactImageEditSelectionToolbar({
  comments,
  imageUploading,
  item,
  onDelete,
  onDownload,
  onOperation,
  onRegionSelectionToggle,
  onSubmitRegionComments,
  regionSelectionActive,
}: {
  comments: readonly EditableImageCanvasRegionComment[];
  imageUploading: boolean;
  item: EditableImageCanvasItem;
  onDelete: (item: EditableImageCanvasItem) => void;
  onDownload: (item: EditableImageCanvasItem) => void;
  onOperation: ArtifactImageEditOperationHandler;
  onRegionSelectionToggle: () => void;
  onSubmitRegionComments: (
    item: EditableImageCanvasItem,
    comments: readonly EditableImageCanvasRegionComment[],
  ) => void;
  regionSelectionActive: boolean;
}) {
  const selectRegionLabel = regionSelectionActive
    ? "Cancel area selection"
    : "Select area";
  return (
    <div
      data-testid="image-edit-toolbar"
      className="flex w-max shrink-0 items-center gap-2 rounded-2xl border border-border/70 bg-gray-50/95 px-2 py-2 shadow-lg backdrop-blur"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <ArtifactImageEditToolbarButton
        active={regionSelectionActive}
        icon={<IconPointer2 size={18} stroke={1.8} />}
        label={selectRegionLabel}
        onClick={onRegionSelectionToggle}
        testId="image-edit-select-region"
      />
      <div
        className="flex items-center overflow-hidden rounded-lg border border-border/70 bg-gray-50"
        data-testid="image-edit-actions-group"
        role="group"
        aria-label="Image edit actions"
      >
        <ArtifactImageEditToolbarButton
          grouped
          icon={<IconBackground size={18} stroke={1.8} />}
          label="Remove background"
          onClick={() => {
            onOperation({ item, operation: "removeBackground" });
          }}
          testId="image-edit-remove-background"
        />
        <span className="h-5 w-px bg-border/70" aria-hidden />
        <ArtifactImageEditToolbarButton
          grouped
          icon={<IconSparkles size={18} stroke={1.8} />}
          label="Enhance"
          onClick={() => {
            onOperation({ item, operation: "enhance" });
          }}
          testId="image-edit-enhance"
        />
        <span className="h-5 w-px bg-border/70" aria-hidden />
        <ArtifactImageStyleTransferPopover
          grouped
          item={item}
          onApply={(stylePrompt, selectedItem) => {
            onOperation({
              item: selectedItem,
              operation: "styleTransfer",
              stylePrompt,
            });
          }}
        />
      </div>
      <div
        className="flex items-center overflow-hidden rounded-lg border border-border/70 bg-gray-50"
        data-testid="image-edit-copy-download-group"
        role="group"
        aria-label="Image link and download actions"
      >
        <ArtifactImageEditToolbarButton
          grouped
          icon={<IconLink size={18} stroke={1.8} />}
          label="Copy link"
          onClick={() => {
            detach(
              copyAttachmentLinkToClipboard(item.src),
              Reason.DomCallback,
              "copyEditableImageCanvasItemLink",
            );
          }}
          testId="image-edit-copy-link"
        />
        <span className="h-5 w-px bg-border/70" aria-hidden />
        <ArtifactImageEditToolbarButton
          grouped
          icon={<IconDownload size={18} stroke={1.8} />}
          label="Download"
          onClick={() => {
            onDownload(item);
          }}
          testId="image-edit-download"
        />
      </div>
      <ArtifactImageEditRegionSendButton
        comments={comments}
        imageUploading={imageUploading}
        item={item}
        onSubmitRegionComments={onSubmitRegionComments}
      />
      <ArtifactImageEditDeleteButton item={item} onDelete={onDelete} />
    </div>
  );
}

function ArtifactImageEditRegionSendButton({
  comments,
  imageUploading,
  item,
  onSubmitRegionComments,
}: {
  comments: readonly EditableImageCanvasRegionComment[];
  imageUploading: boolean;
  item: EditableImageCanvasItem;
  onSubmitRegionComments: (
    item: EditableImageCanvasItem,
    comments: readonly EditableImageCanvasRegionComment[],
  ) => void;
}) {
  if (comments.length === 0) {
    return null;
  }

  return (
    <Button
      type="button"
      size="sm"
      className="h-9 gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:bg-primary/60 disabled:text-primary-foreground/75"
      disabled={imageUploading}
      data-testid="image-edit-region-send"
      aria-label="Send edit instruction"
      title={imageUploading ? "Working" : "Send"}
      onClick={() => {
        onSubmitRegionComments(item, comments);
      }}
    >
      {imageUploading ? (
        <IconLoader2 size={16} className="animate-spin" />
      ) : (
        <IconSend2 size={16} stroke={1.9} />
      )}
      <span>{imageUploading ? "Working" : "Send"}</span>
    </Button>
  );
}

function ArtifactImageEditRegionCommentDraft({
  draft,
  onDraftChange,
  onSubmit,
}: {
  draft: string;
  onDraftChange: (instruction: string) => void;
  onSubmit: (instruction: string) => void;
}) {
  return (
    <div
      data-testid="image-edit-region-comment-form"
      className="flex h-12 w-[min(320px,calc(100vw-32px))] items-center rounded-full border border-border/70 bg-background/95 px-4 text-foreground shadow-xl backdrop-blur"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <input
        autoFocus
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="h-9 min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
        data-testid="image-edit-region-comment-input"
        maxLength={ZERO_IMAGE_INTERPRET_MARKS_MAX_INSTRUCTION_LENGTH}
        placeholder="Describe edit"
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          onDraftChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          onDraftChange(event.currentTarget.value);
          if (event.currentTarget.value.trim()) {
            onSubmit(event.currentTarget.value);
          }
        }}
      />
    </div>
  );
}

function ArtifactImageEditRegionComment({
  comment,
  onEdit,
  onRemove,
}: {
  comment: EditableImageCanvasRegionComment;
  onEdit: (comment: EditableImageCanvasRegionComment) => void;
  onRemove: (comment: EditableImageCanvasRegionComment) => void;
}) {
  return (
    <div
      data-testid="image-edit-region-comment"
      aria-label={`Edit comment: ${comment.instruction}`}
      title={comment.instruction}
      className="relative flex h-9 w-9 items-center justify-center"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-full border border-primary/20 bg-background/95 p-0 text-primary shadow-lg backdrop-blur hover:bg-background hover:text-primary"
        data-testid="image-edit-region-comment-edit"
        aria-label="Edit region comment"
        title="Edit"
        onClick={() => {
          onEdit(comment);
        }}
      >
        <IconMessageCircle size={18} stroke={1.9} />
      </Button>
      <div
        data-testid="image-edit-region-comment-content"
        className="pointer-events-none absolute left-1/2 top-full mt-2 max-w-[min(260px,calc(100vw-32px))] -translate-x-1/2 whitespace-nowrap rounded-lg border border-border/70 bg-background/95 px-3 py-2 text-sm font-medium text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
      >
        {comment.instruction}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="pointer-events-none absolute -right-2 -top-2 h-5 w-5 rounded-full border border-border/70 bg-background p-0 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-muted hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100"
        data-testid="image-edit-region-comment-clear"
        aria-label="Remove edit comment"
        title="Remove"
        onClick={() => {
          onRemove(comment);
        }}
      >
        <IconX size={18} stroke={1.9} />
      </Button>
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
      <button
        type="button"
        className={cn(
          "absolute left-4 top-4 z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors",
          disabled
            ? "cursor-not-allowed opacity-45"
            : "cursor-pointer hover:bg-muted hover:text-foreground",
        )}
        disabled={disabled}
        data-testid="image-edit-upload-local"
        aria-label="Upload from computer"
        title="Upload from computer"
        onClick={(event) => {
          const input = event.currentTarget.nextElementSibling;
          if (input instanceof HTMLInputElement) {
            input.click();
          }
        }}
      >
        {uploading ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconFolderPlus size={17} stroke={1.8} />
        )}
      </button>
      <input
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

function ArtifactImageEditTopLeftControls({
  imageUploading,
  onUploadFiles,
}: {
  imageUploading: boolean;
  onUploadFiles: (files: readonly File[]) => void;
}) {
  return (
    <ArtifactImageEditUploadFileControl
      disabled={imageUploading}
      onSelectFiles={onUploadFiles}
      uploading={imageUploading}
    />
  );
}

function ArtifactImageEditCanvasChrome({
  controls,
  imageUploading,
  onUploadFiles,
}: {
  controls: ZoomableImageControls;
  imageUploading: boolean;
  onUploadFiles: (files: readonly File[]) => void;
}) {
  return (
    <>
      <ArtifactImageZoomControls controls={controls} />
      <ArtifactImageEditTopLeftControls
        imageUploading={imageUploading}
        onUploadFiles={onUploadFiles}
      />
    </>
  );
}

type ArtifactImageEditOperationArgs = {
  item: EditableImageCanvasItem;
  operation: ImageEditOperation;
  regionComments?: readonly ImageEditRegionComment[];
  stylePrompt?: string;
};

type ArtifactImageEditOperationHandler = (
  args: ArtifactImageEditOperationArgs,
) => void;

function imageEditRegionFromEditableRegion(
  region: EditableImageCanvasRegion,
): ImageEditRegion {
  return {
    height: region.height,
    width: region.width,
    x: region.x,
    y: region.y,
  };
}

function imageEditCommentFromEditableComment(
  comment: EditableImageCanvasRegionComment,
): ImageEditRegionComment {
  return {
    id: comment.id,
    instruction: comment.instruction,
    region: imageEditRegionFromEditableRegion(comment.region),
  };
}

type AddRegionComment = (args: {
  instruction: string;
  key: string;
  region: EditableImageCanvasRegion;
}) => boolean;

function createAddRegionCommentHandler({
  addCanvasRegionComment,
  canvasKey,
}: {
  addCanvasRegionComment: AddRegionComment;
  canvasKey: string;
}) {
  return (region: EditableImageCanvasRegion, instruction: string) => {
    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction) {
      toast.error("Describe the change you want");
      return;
    }
    const added = addCanvasRegionComment({
      instruction: trimmedInstruction,
      key: canvasKey,
      region,
    });
    if (!added) {
      toast.error(
        `You can add up to ${ZERO_IMAGE_INTERPRET_MARKS_MAX_REGIONS} edits per image`,
      );
    }
  };
}

function createSubmitRegionCommentsHandler({
  onOperation,
}: {
  onOperation: ArtifactImageEditOperationHandler;
}) {
  return (
    item: EditableImageCanvasItem,
    comments: readonly EditableImageCanvasRegionComment[],
  ) => {
    if (comments.length === 0) {
      return;
    }
    onOperation({
      item,
      operation: "editRegion",
      regionComments: comments.map((comment) => {
        return imageEditCommentFromEditableComment(comment);
      }),
    });
  };
}

function useArtifactImageEditOperationAction({
  artifactUrl,
  canvasKey,
  canvasSrc,
  pageSignal,
}: {
  artifactUrl: string;
  canvasKey: string;
  canvasSrc: string;
  pageSignal: AbortSignal;
}): ArtifactImageEditOperationHandler {
  const runImageEdit = useSet(runImageEdit$);
  return (args) => {
    detach(
      runImageEdit(
        {
          artifactUrl,
          canvasKey,
          canvasSrc,
          operation: args.operation,
          regionComments: args.regionComments,
          sourceImageNaturalHeight: args.item.naturalHeight,
          sourceImageNaturalWidth: args.item.naturalWidth,
          sourceItemId: args.item.id,
          stylePrompt: args.stylePrompt,
          url: args.item.src,
        },
        pageSignal,
      ),
      Reason.DomCallback,
      "runImageEdit",
    );
  };
}

function useArtifactImageEditTransferActions({
  artifactUrl,
  canvasKey,
  canvasSrc,
  pageSignal,
}: {
  artifactUrl: string;
  canvasKey: string;
  canvasSrc: string;
  pageSignal: AbortSignal;
}) {
  const deleteCanvasItem = useSet(deleteEditableImageCanvasItem$);
  const persistCanvasSnapshot = useSet(persistEditableImageCanvasSnapshot$);
  const uploadCanvasImage = useSet(uploadEditableImageCanvasImage$);

  const onDelete = (item: EditableImageCanvasItem) => {
    deleteCanvasItem({
      itemId: item.id,
      key: canvasKey,
      src: canvasSrc,
    });
    detach(
      persistCanvasSnapshot(
        { canvasSrc, key: canvasKey, url: artifactUrl },
        pageSignal,
      ),
      Reason.DomCallback,
      "persistEditableImageCanvasSnapshotAfterDelete",
    );
  };
  const onUploadFiles = (files: readonly File[]) => {
    detach(
      uploadCanvasImage(
        { artifactUrl, canvasKey, canvasSrc },
        files,
        pageSignal,
      ),
      Reason.DomCallback,
      "uploadEditableImageCanvasImage",
    );
  };

  return { onDelete, onUploadFiles };
}

function useArtifactImageEditActions({
  artifactUrl,
  canvasKey,
  canvasSrc,
  filename,
  pageSignal,
  regionSelectionActive,
}: {
  artifactUrl: string;
  canvasKey: string;
  canvasSrc: string;
  filename: string;
  pageSignal: AbortSignal;
  regionSelectionActive: boolean;
}) {
  const addCanvasRegionComment = useSet(addEditableImageCanvasRegionComment$);
  const clearCanvasRegionSelection = useSet(
    clearEditableImageCanvasRegionSelection$,
  );
  const removeCanvasRegionComment = useSet(
    removeEditableImageCanvasRegionComment$,
  );
  const setCanvasRegionInstructionDraft = useSet(
    setEditableImageCanvasRegionInstructionDraft$,
  );
  const startEditingCanvasRegionComment = useSet(
    startEditingEditableImageCanvasRegionComment$,
  );
  const startCanvasRegionSelection = useSet(
    startEditableImageCanvasRegionSelection$,
  );
  const onOperation = useArtifactImageEditOperationAction({
    artifactUrl,
    canvasKey,
    canvasSrc,
    pageSignal,
  });
  const transferActions = useArtifactImageEditTransferActions({
    artifactUrl,
    canvasKey,
    canvasSrc,
    pageSignal,
  });
  const onDownload = (item: EditableImageCanvasItem) => {
    detach(
      downloadAttachmentUrl(item.src, pageSignal, filename),
      Reason.DomCallback,
      "downloadEditableImageCanvasItem",
    );
  };
  const onRegionSelectionToggle = () => {
    if (regionSelectionActive) {
      clearCanvasRegionSelection(canvasKey);
      return;
    }
    startCanvasRegionSelection(canvasKey);
  };
  const onRegionInstructionDraftChange = (instruction: string) => {
    setCanvasRegionInstructionDraft({
      instruction,
      key: canvasKey,
    });
  };
  const onAddRegionComment = createAddRegionCommentHandler({
    addCanvasRegionComment,
    canvasKey,
  });
  const onRemoveRegionComment = (comment: EditableImageCanvasRegionComment) => {
    removeCanvasRegionComment({
      commentId: comment.id,
      key: canvasKey,
    });
  };
  const onEditRegionComment = (comment: EditableImageCanvasRegionComment) => {
    startEditingCanvasRegionComment({
      commentId: comment.id,
      key: canvasKey,
    });
  };
  const onSubmitRegionComments = createSubmitRegionCommentsHandler({
    onOperation,
  });

  return {
    onDelete: transferActions.onDelete,
    onDownload,
    onAddRegionComment,
    onEditRegionComment,
    onOperation,
    onRegionInstructionDraftChange,
    onRemoveRegionComment,
    onRegionSelectionToggle,
    onSubmitRegionComments,
    onUploadFiles: transferActions.onUploadFiles,
  };
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
  const canvasSrc = publicAttachmentUrl(url);
  const canvasKey = editableImageArtifactCanvasKey(url);
  const regionCommentsByKey = useGet(editableImageCanvasRegionCommentsByKey$);
  const regionInstructionDraftByKey = useGet(
    editableImageCanvasRegionInstructionDraftByKey$,
  );
  const regionSelectionActiveByKey = useGet(
    editableImageCanvasRegionSelectionActiveByKey$,
  );
  const regionComments = regionCommentsByKey[canvasKey] ?? [];
  const regionInstructionDraft = regionInstructionDraftByKey[canvasKey] ?? "";
  const regionSelectionActive = regionSelectionActiveByKey[canvasKey] ?? false;
  const setImageEditSnapshotControllerRef = useSet(
    setImageEditSnapshotControllerRef$,
  );
  const actions = useArtifactImageEditActions({
    artifactUrl: url,
    canvasKey,
    canvasSrc,
    filename,
    pageSignal,
    regionSelectionActive,
  });
  const commentsForItem = (itemId: string) => {
    return regionComments.filter((comment) => {
      return comment.region.itemId === itemId;
    });
  };

  return (
    <div
      key={canvasKey}
      ref={setImageEditSnapshotControllerRef}
      className="h-full min-h-0"
      data-image-edit-snapshot-canvas-key={canvasKey}
      data-image-edit-snapshot-canvas-src={canvasSrc}
      data-image-edit-snapshot-url={url}
    >
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
              renderRegionToolbar={(region) => {
                return (
                  <ArtifactImageEditRegionCommentDraft
                    draft={regionInstructionDraft}
                    onDraftChange={actions.onRegionInstructionDraftChange}
                    onSubmit={(instruction) => {
                      actions.onAddRegionComment(region, instruction);
                    }}
                  />
                );
              }}
              renderRegionComment={(comment) => {
                return (
                  <ArtifactImageEditRegionComment
                    comment={comment}
                    onEdit={actions.onEditRegionComment}
                    onRemove={actions.onRemoveRegionComment}
                  />
                );
              }}
              renderSelectionToolbar={(item) => {
                return (
                  <ArtifactImageEditSelectionToolbar
                    comments={commentsForItem(item.id)}
                    imageUploading={imageUploading}
                    item={item}
                    onDelete={actions.onDelete}
                    onDownload={actions.onDownload}
                    onOperation={actions.onOperation}
                    onRegionSelectionToggle={actions.onRegionSelectionToggle}
                    onSubmitRegionComments={actions.onSubmitRegionComments}
                    regionSelectionActive={regionSelectionActive}
                  />
                );
              }}
            >
              {(controls) => {
                return (
                  <ArtifactImageEditCanvasChrome
                    controls={controls}
                    imageUploading={imageUploading}
                    onUploadFiles={actions.onUploadFiles}
                  />
                );
              }}
            </EditableArtifactImageCanvas>
          </div>
        </ArtifactStageCard>
      </ArtifactStageShell>
    </div>
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
