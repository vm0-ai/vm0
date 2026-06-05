import type { MouseEvent, ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { createPortal } from "react-dom";
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconColumns2,
  IconDownload,
  IconFileMusic,
  IconPhoto,
  IconLoader2,
  IconShare,
  IconZoomIn,
  IconZoomOut,
  IconZoomReset,
  IconX,
} from "@tabler/icons-react";
import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroChatAttachment } from "../../signals/chat-page/chat-message.ts";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  imageLightboxImageRef$,
  imageLightboxState$,
  imageLoadStatusByKey$,
  imageLoadStatusRef$,
  resetZoomableImageCanvasZoom$,
  setImageLightboxStatus$,
  setImageLoadStatus$,
  textPreviewLoaderRef$,
  textPreviewLoadStateByKey$,
  type TextPreviewLoadState,
} from "../../signals/view-component-state.ts";
import { Markdown } from "../components/markdown.tsx";
import {
  lightboxUrl$,
  closeLightbox$,
  closeLightboxWithDialogExit$,
  lightboxDialogFullscreen$,
  lightboxDialogVisible$,
  openAudioLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  lightboxDialogRef$,
  toggleLightboxDialogFullscreen$,
  type AttachmentArtifactMetadata,
  type AttachmentLightboxState,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  chatArtifactSidebarEnabled$,
  openArtifactSidebarPreview$,
} from "../../signals/zero-page/zero-artifact-sidebar.ts";
import { FilePreviewIcon } from "./zero-file-preview-icon.tsx";
import {
  attachmentFilenameFromUrl,
  copyAttachmentLinkToClipboard,
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "./zero-attachment-url.ts";
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
import {
  ZoomableArtifactImageCanvas,
  type ZoomableImageControls,
  zoomableArtifactImageKey,
} from "./zero-zoomable-image-canvas.tsx";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";

export {
  downloadAttachmentUrl,
  getAttachmentRawUrl,
  publicAttachmentUrl,
} from "./zero-attachment-url.ts";

type DocumentAttachmentPreviewKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf";

function contentTypeForDocumentAttachmentPreviewKind(
  kind: DocumentAttachmentPreviewKind,
): string {
  if (kind === "csv") {
    return "text/csv";
  }
  if (kind === "markdown") {
    return "text/markdown";
  }
  if (kind === "text") {
    return "text/plain";
  }
  if (kind === "json") {
    return "application/json";
  }
  if (kind === "html") {
    return "text/html";
  }
  return "application/pdf";
}

const ATTACHMENT_LIGHTBOX_OVERLAY_CLASS =
  "zero-dialog-enter-overlay pointer-events-auto fixed inset-0 z-[9999] isolate flex items-center justify-center bg-black/80 backdrop-blur-sm outline-none";

const ATTACHMENT_LIGHTBOX_PANEL_CLASS = "zero-dialog-enter-content";

// ---------------------------------------------------------------------------
// AttachmentLightbox — full-screen attachment viewer
// ---------------------------------------------------------------------------

export function TextPreviewLoader({
  url,
  children,
}: {
  url: string;
  signal: AbortSignal;
  children: (state: TextPreviewLoadState) => ReactNode;
}) {
  const textPreviewLoadStates = useGet(textPreviewLoadStateByKey$);
  const textPreviewLoaderRef = useSet(textPreviewLoaderRef$);
  const textPreviewKey = `attachment-lightbox:${url}`;
  const loadState = textPreviewLoadStates[textPreviewKey] ?? {
    status: "loading",
    text: "",
  };

  return (
    <>
      <span
        key={textPreviewKey}
        ref={textPreviewLoaderRef}
        data-text-preview-key={textPreviewKey}
        data-text-preview-url={url}
        hidden
      />
      {children(loadState)}
    </>
  );
}

function formatPlainPreviewText(
  kind: "text" | "json" | "csv",
  text: string,
): string {
  if (kind === "json") {
    const parsed = jsonParseOr<unknown>(text, null);
    return parsed === null ? text : JSON.stringify(parsed, null, 2);
  }
  return text;
}

export function parseCsvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => {
      return line.trimEnd();
    })
    .filter((line) => {
      return line.length > 0;
    })
    .map((line) => {
      return line.split(",").map((cell) => {
        return cell.trim();
      });
    });
}

export function CsvPreviewTable({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows;

  return (
    <div className="overflow-auto rounded-lg border border-foreground/10">
      <table className="min-w-full divide-y divide-foreground/10 text-sm">
        <thead className="bg-muted/40">
          <tr>
            {header.map((cell) => {
              return (
                <th
                  key={`header-${cell}`}
                  className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground"
                >
                  {cell}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-foreground/10 bg-background">
          {body.map((row) => {
            const rowKey = `row-${row.join("\u0001")}`;
            return (
              <tr key={rowKey}>
                {header.map((column, cellIndex) => {
                  const value = row[cellIndex] ?? "";
                  return (
                    <td
                      key={`${rowKey}-${column}-${value}`}
                      className="whitespace-nowrap px-3 py-2 text-foreground"
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LightboxBodyScrollLock() {
  let restore: (() => void) | null = null;

  return (
    <span
      ref={(node) => {
        if (node === null) {
          restore?.();
          restore = null;
          return;
        }

        const bodyOverflow = document.body.style.overflow;
        const bodyOverscrollBehavior = document.body.style.overscrollBehavior;
        const rootOverflow = document.documentElement.style.overflow;
        const rootOverscrollBehavior =
          document.documentElement.style.overscrollBehavior;

        document.body.style.overflow = "hidden";
        document.body.style.overscrollBehavior = "contain";
        document.documentElement.style.overflow = "hidden";
        document.documentElement.style.overscrollBehavior = "contain";

        restore = () => {
          document.body.style.overflow = bodyOverflow;
          document.body.style.overscrollBehavior = bodyOverscrollBehavior;
          document.documentElement.style.overflow = rootOverflow;
          document.documentElement.style.overscrollBehavior =
            rootOverscrollBehavior;
        };
      }}
      hidden
    />
  );
}

function isImageLightboxZoomAtReset(zoom: number): boolean {
  return Math.abs(zoom - 1) < 0.001;
}

function DialogIconButton({
  ariaLabel,
  children,
  onClick,
}: {
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {children}
    </button>
  );
}

function ArtifactDialogSplitViewButton({ onClick }: { onClick: () => void }) {
  return (
    <DialogIconButton ariaLabel="Open in split view" onClick={onClick}>
      <IconColumns2 size={18} stroke={1.8} />
    </DialogIconButton>
  );
}

function ArtifactDialogFullscreenButton({
  fullscreen,
  onClick,
}: {
  fullscreen: boolean;
  onClick: () => void;
}) {
  return (
    <DialogIconButton
      ariaLabel={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      onClick={onClick}
    >
      {fullscreen ? (
        <IconArrowsDiagonalMinimize2 size={18} stroke={1.8} />
      ) : (
        <IconArrowsDiagonal size={18} stroke={1.8} />
      )}
    </DialogIconButton>
  );
}

function ImageLightboxControls({
  closeLightbox,
  copyLink,
  download,
  resetZoom,
  zoom,
  zoomIn,
  zoomOut,
}: {
  closeLightbox: () => void;
  copyLink: () => void;
  download: () => void;
  resetZoom: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
}) {
  return (
    <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-full bg-black/50 p-1 text-white">
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoom <= IMAGE_LIGHTBOX_MIN_ZOOM}
          className="rounded-full p-1.5 transition-colors hover:bg-white/15 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Zoom out"
          title="Zoom out"
        >
          <IconZoomOut size={18} stroke={2} />
        </button>
        <span className="min-w-10 text-center text-xs font-medium tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoom >= IMAGE_LIGHTBOX_MAX_ZOOM}
          className="rounded-full p-1.5 transition-colors hover:bg-white/15 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Zoom in"
          title="Zoom in"
        >
          <IconZoomIn size={18} stroke={2} />
        </button>
        <button
          type="button"
          onClick={resetZoom}
          disabled={isImageLightboxZoomAtReset(zoom)}
          className="rounded-full p-1.5 transition-colors hover:bg-white/15 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          <IconZoomReset size={18} stroke={2} />
        </button>
      </div>
      <button
        type="button"
        onClick={copyLink}
        className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
        aria-label="Share"
      >
        <IconShare size={20} stroke={2} />
      </button>
      <button
        type="button"
        onClick={download}
        className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
        aria-label="Download"
      >
        <IconDownload size={20} stroke={2} />
      </button>
      <button
        type="button"
        onClick={closeLightbox}
        className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Close"
      >
        <IconX size={20} stroke={2} />
      </button>
    </div>
  );
}

function ImageLightboxContent({
  closeLightbox,
  pageSignal,
  url,
}: {
  closeLightbox: () => void;
  pageSignal: AbortSignal;
  url: string;
}) {
  const imageLightboxImageRef = useSet(imageLightboxImageRef$);
  const setImageLightboxStatus = useSet(setImageLightboxStatus$);

  const download = () => {
    detach(
      downloadAttachmentUrl(url, pageSignal),
      Reason.DomCallback,
      "attachment download",
    );
  };
  const copyLink = () => {
    detach(
      copyAttachmentLinkToClipboard(url),
      Reason.DomCallback,
      "attachment copy link",
    );
  };

  const { imageStatus } = useGet(imageLightboxState$);

  return (
    <ZoomableArtifactImageCanvas
      src={url}
      alt=""
      zoomKey={zoomableArtifactImageKey("attachment-lightbox", url)}
      keyboardShortcuts
      imageRef={imageLightboxImageRef}
      imageTestId="attachment-lightbox-image"
      canvasTestId="attachment-lightbox-panel"
      onLoad={() => {
        setImageLightboxStatus("loaded");
      }}
      onError={() => {
        setImageLightboxStatus("error");
      }}
      className={`relative z-10 h-[min(85vh,720px)] w-[min(90vw,1100px)] bg-transparent ${ATTACHMENT_LIGHTBOX_PANEL_CLASS}`}
      imageClassName={`rounded-lg shadow-2xl ${
        imageStatus === "loaded" ? "" : "opacity-0"
      }`}
    >
      {({ resetZoom, zoom, zoomIn, zoomOut }) => {
        return (
          <>
            <ImageLightboxControls
              closeLightbox={closeLightbox}
              copyLink={copyLink}
              download={download}
              resetZoom={resetZoom}
              zoom={zoom}
              zoomIn={zoomIn}
              zoomOut={zoomOut}
            />
            {imageStatus !== "loaded" && (
              <div
                data-testid="attachment-lightbox-image-loading"
                className="absolute left-1/2 top-1/2 z-10 flex h-[min(85vh,480px)] w-[min(90vw,720px)] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg bg-black/30 text-white shadow-2xl"
              >
                {imageStatus === "loading" ? (
                  <IconLoader2
                    size={24}
                    stroke={1.8}
                    className="animate-spin"
                  />
                ) : (
                  <IconPhoto size={24} stroke={1.5} />
                )}
              </div>
            )}
          </>
        );
      }}
    </ZoomableArtifactImageCanvas>
  );
}

function ImageLightbox({ url }: { url: string }) {
  const dialogRef = useSet(lightboxDialogRef$);
  const closeLightbox = useSet(closeLightbox$);
  const pageSignal = useGet(pageSignal$);

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeLightbox();
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={ATTACHMENT_LIGHTBOX_OVERLAY_CLASS}
      style={{ pointerEvents: "auto" }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      data-testid="attachment-lightbox"
    >
      <LightboxBodyScrollLock />
      <ImageLightboxContent
        closeLightbox={closeLightbox}
        pageSignal={pageSignal}
        url={url}
      />
    </div>,
    document.body,
  );
}

function VideoLightbox({ filename, url }: { filename: string; url: string }) {
  const dialogRef = useSet(lightboxDialogRef$);
  const closeLightbox = useSet(closeLightbox$);
  const pageSignal = useGet(pageSignal$);
  const videoUrl = publicAttachmentUrl(url);

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeLightbox();
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={ATTACHMENT_LIGHTBOX_OVERLAY_CLASS}
      style={{ pointerEvents: "auto" }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      data-testid="attachment-lightbox"
    >
      <LightboxBodyScrollLock />
      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            detach(
              copyAttachmentLinkToClipboard(url),
              Reason.DomCallback,
              "attachment copy link",
            );
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
          aria-label="Share"
        >
          <IconShare size={20} stroke={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            detach(
              downloadAttachmentUrl(url, pageSignal, filename),
              Reason.DomCallback,
              "attachment download",
            );
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
          aria-label="Download"
        >
          <IconDownload size={20} stroke={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            closeLightbox();
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          aria-label="Close"
        >
          <IconX size={20} stroke={2} />
        </button>
      </div>
      <div
        className={`relative z-10 flex w-[min(92vw,1100px)] min-w-0 overflow-hidden bg-black shadow-2xl ${ATTACHMENT_LIGHTBOX_PANEL_CLASS}`}
        data-testid="attachment-lightbox-panel"
      >
        <video
          src={videoUrl}
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="block max-h-[78vh] w-full bg-black object-contain"
          aria-label={`Video preview for ${filename}`}
        />
      </div>
    </div>,
    document.body,
  );
}

function AudioLightbox({ filename, url }: { filename: string; url: string }) {
  const dialogRef = useSet(lightboxDialogRef$);
  const closeLightbox = useSet(closeLightbox$);
  const pageSignal = useGet(pageSignal$);
  const audioUrl = publicAttachmentUrl(url);

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeLightbox();
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={ATTACHMENT_LIGHTBOX_OVERLAY_CLASS}
      style={{ pointerEvents: "auto" }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      data-testid="attachment-lightbox"
    >
      <LightboxBodyScrollLock />
      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            detach(
              copyAttachmentLinkToClipboard(url),
              Reason.DomCallback,
              "attachment copy link",
            );
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
          aria-label="Share"
        >
          <IconShare size={20} stroke={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            detach(
              downloadAttachmentUrl(url, pageSignal, filename),
              Reason.DomCallback,
              "attachment download",
            );
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
          aria-label="Download"
        >
          <IconDownload size={20} stroke={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            closeLightbox();
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          aria-label="Close"
        >
          <IconX size={20} stroke={2} />
        </button>
      </div>
      <div
        className={`relative z-10 flex w-[min(92vw,560px)] min-w-0 flex-col items-center gap-4 overflow-hidden rounded-2xl bg-background p-6 shadow-2xl ${ATTACHMENT_LIGHTBOX_PANEL_CLASS}`}
        data-testid="attachment-lightbox-panel"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/70 bg-muted/50 text-muted-foreground">
          <IconFileMusic size={28} stroke={1.6} />
        </span>
        <div className="max-w-full truncate text-sm font-medium text-foreground">
          {filename}
        </div>
        <audio
          src={audioUrl}
          controls
          autoPlay
          preload="metadata"
          className="w-full"
          aria-label={`Audio preview for ${filename}`}
          data-testid="attachment-lightbox-audio"
        />
      </div>
    </div>,
    document.body,
  );
}

function artifactDialogFilename(preview: AttachmentLightboxState): string {
  return "filename" in preview && preview.filename
    ? preview.filename
    : attachmentFilenameFromUrl(preview.url);
}

type ArtifactDialogItem = {
  runId: string;
  file: ChatThreadArtifactFile;
};

function artifactDialogKindLabel(
  preview: AttachmentLightboxState,
  artifact: AttachmentArtifactMetadata | undefined,
): string {
  if (artifact) {
    return artifactTitleSubtitle(preview.kind, artifact);
  }
  return artifactFallbackSubtitle(
    preview.kind,
    artifactDialogFilename(preview),
  );
}

function artifactDialogSyncTarget(
  artifact: AttachmentArtifactMetadata | undefined,
): ArtifactDownloadSyncTarget | undefined {
  if (!artifact) {
    return undefined;
  }
  return {
    agentId: artifact.agentId,
    fileId: artifact.fileId,
    filename: artifact.filename,
    onSyncSuccess:
      artifact.onSyncSuccess ??
      (() => {
        return undefined;
      }),
    runId: artifact.runId,
    synced: artifact.googleDriveSynced,
    threadId: artifact.threadId,
  };
}

function findArtifactDialogItemForUrl(
  runs: ChatThreadArtifactRun[],
  url: string,
): ArtifactDialogItem | undefined {
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

function artifactDialogMetadataFromItem(params: {
  agentId: string | null | undefined;
  item: ArtifactDialogItem;
  onSyncSuccess: () => void;
  threadId: string;
}): AttachmentArtifactMetadata {
  return {
    agentId: params.agentId,
    contentType: params.item.file.contentType,
    createdAt: params.item.file.createdAt,
    fileId: params.item.file.id,
    filename: params.item.file.filename,
    googleDriveSynced: params.item.file.googleDriveSync?.status === "synced",
    onSyncSuccess: params.onSyncSuccess,
    runId: params.item.runId,
    size: params.item.file.size,
    threadId: params.threadId,
  };
}

function ArtifactDialogLoadingBody() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-muted-foreground">
      <IconLoader2 size={20} stroke={1.8} className="animate-spin" />
    </div>
  );
}

function ArtifactDialogUnavailableBody({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      {label} preview unavailable.
    </div>
  );
}

function ArtifactDialogStage({
  children,
  centered = false,
  flush = false,
  gap = false,
  scrollable = true,
}: {
  children: ReactNode;
  centered?: boolean;
  flush?: boolean;
  gap?: boolean;
  scrollable?: boolean;
}) {
  return (
    <div
      className={`h-full min-h-0 bg-muted/30 ${flush ? "p-0" : "p-5"} ${
        scrollable ? "overflow-auto" : "overflow-hidden"
      }`}
      data-testid="artifact-dialog-stage"
    >
      <div
        className={`mx-auto flex w-full flex-col ${
          flush ? "max-w-none" : "max-w-[900px]"
        } ${scrollable ? "min-h-full" : "h-full min-h-0"} ${
          centered ? "items-center justify-center" : ""
        } ${gap ? "gap-3" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

function ArtifactDialogCard({
  children,
  fillHeight = false,
}: {
  children: ReactNode;
  fillHeight?: boolean;
}) {
  return (
    <div
      className={`flex w-full flex-1 flex-col overflow-hidden ${
        fillHeight
          ? "h-full min-h-0 bg-transparent"
          : "min-h-[420px] rounded-xl border border-border/70 bg-background shadow-sm"
      }`}
      data-testid="artifact-dialog-card"
    >
      {children}
    </div>
  );
}

function ArtifactDialogImageZoomControls({
  controls,
}: {
  controls: ZoomableImageControls;
}) {
  return (
    <div
      className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg bg-background/95 px-2.5 py-1.5 text-muted-foreground shadow-sm backdrop-blur-sm"
      data-testid="artifact-dialog-image-zoom-controls"
    >
      <button
        type="button"
        onClick={controls.zoomOut}
        disabled={!controls.canZoomOut}
        className="flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="Zoom out"
        title="Zoom out"
      >
        -
      </button>
      <span className="min-w-10 text-center text-xs font-medium tabular-nums text-foreground">
        {Math.round(controls.zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={controls.zoomIn}
        disabled={!controls.canZoomIn}
        className="flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="Zoom in"
        title="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        onClick={controls.resetZoom}
        className="flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-muted/70 hover:text-foreground"
        aria-label="Reset zoom"
        title="Reset zoom"
      >
        <IconZoomReset size={15} stroke={1.8} />
      </button>
    </div>
  );
}

function ArtifactDialogTextBody({
  kind,
  signal,
  url,
}: {
  kind: "markdown" | "text" | "json" | "csv";
  signal: AbortSignal;
  url: string;
}) {
  return (
    <TextPreviewLoader url={url} signal={signal}>
      {({ status, text }) => {
        if (status === "loading") {
          return (
            <ArtifactDialogStage>
              <ArtifactDialogCard>
                <ArtifactDialogLoadingBody />
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }

        if (status === "error") {
          return (
            <ArtifactDialogStage>
              <ArtifactDialogCard>
                <ArtifactDialogUnavailableBody
                  label={
                    kind === "json"
                      ? "JSON"
                      : kind === "csv"
                        ? "CSV"
                        : kind === "markdown"
                          ? "Markdown"
                          : "Text"
                  }
                />
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }

        if (kind === "markdown") {
          return (
            <ArtifactDialogStage>
              <ArtifactDialogCard>
                <div className="h-full overflow-auto p-6">
                  <Markdown source={text} />
                </div>
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }

        if (kind === "csv") {
          const rows = parseCsvRows(text);
          return (
            <ArtifactDialogStage>
              <ArtifactDialogCard>
                <div className="h-full overflow-auto p-5">
                  {rows.length > 0 ? (
                    <CsvPreviewTable rows={rows} />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      CSV preview unavailable.
                    </div>
                  )}
                </div>
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }

        const formatted = formatPlainPreviewText(kind, text);
        const display =
          formatted.length > 16_000
            ? `${formatted.slice(0, 16_000)}\n\n…`
            : formatted;

        return (
          <ArtifactDialogStage>
            <ArtifactDialogCard>
              <pre className="m-0 h-full overflow-auto whitespace-pre-wrap break-words p-6 text-sm text-foreground">
                {display}
              </pre>
            </ArtifactDialogCard>
          </ArtifactDialogStage>
        );
      }}
    </TextPreviewLoader>
  );
}

function ArtifactDialogBody({
  pageSignal,
  preview,
}: {
  pageSignal: AbortSignal;
  preview: AttachmentLightboxState;
}) {
  const filename = artifactDialogFilename(preview);
  const fullscreen = useGet(lightboxDialogFullscreen$);

  if (preview.kind === "image") {
    return (
      <ArtifactDialogStage flush scrollable={false}>
        <ArtifactDialogCard fillHeight>
          <ZoomableArtifactImageCanvas
            src={publicAttachmentUrl(preview.url)}
            alt={filename}
            zoomKey={artifactDialogImageZoomKey(preview.url, fullscreen)}
            imageTestId="attachment-lightbox-image"
            contentClassName="p-6"
            imageClassName="rounded-lg shadow-sm"
            canvasTestId="artifact-dialog-image-stage"
          >
            {(controls) => {
              return <ArtifactDialogImageZoomControls controls={controls} />;
            }}
          </ZoomableArtifactImageCanvas>
        </ArtifactDialogCard>
      </ArtifactDialogStage>
    );
  }

  if (preview.kind === "video") {
    return (
      <ArtifactDialogStage centered>
        <div
          className="w-full overflow-hidden rounded-xl border border-border/70 bg-black shadow-sm"
          data-testid="artifact-dialog-video-stage"
        >
          <video
            src={publicAttachmentUrl(preview.url)}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="block aspect-video w-full bg-black object-contain"
            aria-label={`Video preview for ${filename}`}
          />
        </div>
      </ArtifactDialogStage>
    );
  }

  if (preview.kind === "audio") {
    return (
      <ArtifactDialogStage centered>
        <div className="flex w-full max-w-[520px] flex-col items-center gap-4 rounded-xl border border-border/70 bg-background p-6 shadow-sm">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/70 bg-muted/50 text-muted-foreground">
            <IconFileMusic size={28} stroke={1.6} />
          </span>
          <p className="max-w-full truncate text-sm text-muted-foreground">
            {filename}
          </p>
          <audio
            src={publicAttachmentUrl(preview.url)}
            controls
            autoPlay
            preload="metadata"
            className="w-full"
            aria-label={`Audio preview for ${filename}`}
            data-testid="artifact-dialog-audio"
          />
        </div>
      </ArtifactDialogStage>
    );
  }

  if (
    preview.kind === "markdown" ||
    preview.kind === "text" ||
    preview.kind === "json" ||
    preview.kind === "csv"
  ) {
    return (
      <ArtifactDialogTextBody
        kind={preview.kind}
        signal={pageSignal}
        url={preview.url}
      />
    );
  }

  if (preview.kind === "html") {
    return (
      <div
        className="h-full w-full bg-background"
        data-testid="artifact-dialog-site-frame"
      >
        <AutoFocusedArtifactIframe
          focusKey={`${preview.url}:${fullscreen ? "fullscreen" : "dialog"}`}
          focusOnMount
          src={preview.url}
          title={`${filename} preview`}
          sandbox="allow-scripts"
          scrolling="yes"
          className="block h-full w-full border-0 bg-background"
          data-testid="artifact-dialog-body-html"
        />
      </div>
    );
  }

  return (
    <ArtifactDialogStage>
      <div
        className="flex min-h-[420px] w-full flex-1 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm"
        data-testid="artifact-dialog-document-frame"
      >
        <iframe
          src={
            preview.kind === "pdf" ? `${preview.url}#navpanes=0` : preview.url
          }
          title={`${filename} preview`}
          scrolling="yes"
          className="block h-full w-full bg-background"
        />
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactPreviewDialog({
  preview,
}: {
  preview: AttachmentLightboxState;
}) {
  const leftThread = useLastResolved(currentLeftThread$);
  const rightThread = useLastResolved(currentRightThread$);

  if (leftThread) {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={leftThread}
        fallbackThread={
          rightThread && rightThread.threadId !== leftThread.threadId
            ? rightThread
            : undefined
        }
      />
    );
  }

  if (rightThread) {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={rightThread}
      />
    );
  }

  return (
    <ArtifactPreviewDialogContent
      artifact={preview.artifact}
      preview={preview}
    />
  );
}

function ArtifactPreviewDialogThreadResolver({
  fallbackThread,
  preview,
  thread,
}: {
  fallbackThread?: ChatThreadSignals;
  preview: AttachmentLightboxState;
  thread: ChatThreadSignals;
}) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = useLastResolved(thread.agentId$);
  const reloadArtifacts = useSet(thread.setArtifactsDrawerOpen$);
  const item =
    loadable.state === "hasData"
      ? findArtifactDialogItemForUrl(loadable.data, preview.url)
      : undefined;

  if (item) {
    return (
      <ArtifactPreviewDialogContent
        artifact={artifactDialogMetadataFromItem({
          agentId,
          item,
          onSyncSuccess: () => {
            reloadArtifacts(true);
          },
          threadId: thread.threadId,
        })}
        preview={preview}
      />
    );
  }

  if (fallbackThread && loadable.state === "hasData") {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={fallbackThread}
      />
    );
  }

  return (
    <ArtifactPreviewDialogContent
      artifact={preview.artifact}
      preview={preview}
    />
  );
}

function artifactDialogImageZoomKey(url: string, fullscreen: boolean) {
  return zoomableArtifactImageKey(
    "artifact-dialog",
    url,
    fullscreen ? "fullscreen" : "windowed",
  );
}

function resetArtifactDialogImageZoom({
  fullscreen,
  preview,
  resetZoom,
  targetFullscreen,
}: {
  fullscreen: boolean;
  preview: AttachmentLightboxState;
  resetZoom: (key: string) => void;
  targetFullscreen: boolean;
}) {
  if (preview.kind !== "image") {
    return;
  }
  resetZoom(artifactDialogImageZoomKey(preview.url, fullscreen));
  resetZoom(artifactDialogImageZoomKey(preview.url, targetFullscreen));
}

function ArtifactPreviewDialogContent({
  artifact,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  preview: AttachmentLightboxState;
}) {
  const dialogRef = useSet(lightboxDialogRef$);
  const closeLightboxWithDialogExit = useSet(closeLightboxWithDialogExit$);
  const openArtifactSidebarPreview = useSet(openArtifactSidebarPreview$);
  const toggleLightboxDialogFullscreen = useSet(
    toggleLightboxDialogFullscreen$,
  );
  const resetZoomableImageCanvasZoom = useSet(resetZoomableImageCanvasZoom$);
  const pageSignal = useGet(pageSignal$);
  const filename = artifact?.filename ?? artifactDialogFilename(preview);
  const subtitle = artifactDialogKindLabel(preview, artifact);
  const syncTarget = artifactDialogSyncTarget(artifact);
  const visible = useGet(lightboxDialogVisible$);
  const fullscreen = useGet(lightboxDialogFullscreen$);

  const closeWithAnimation = () => {
    closeLightboxWithDialogExit();
  };

  const resetDialogImageZoom = (targetFullscreen: boolean) => {
    resetArtifactDialogImageZoom({
      fullscreen,
      preview,
      resetZoom: resetZoomableImageCanvasZoom,
      targetFullscreen,
    });
  };

  const openInSplitView = () => {
    resetDialogImageZoom(fullscreen);
    if (preview.kind === "image") {
      resetZoomableImageCanvasZoom(
        zoomableArtifactImageKey("artifact-sidebar", preview.url, "sidebar"),
      );
    }
    openArtifactSidebarPreview(preview.url);
    closeLightboxWithDialogExit();
  };

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeWithAnimation();
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={`zero-dialog-enter-overlay fixed inset-0 z-[9999] isolate flex items-center justify-center bg-gray-900/45 outline-none transition-opacity duration-[180ms] ease ${
        visible
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0"
      } ${fullscreen ? "p-0" : "p-6"}`}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={`${filename} preview`}
      data-testid="attachment-lightbox"
    >
      <LightboxBodyScrollLock />
      <div
        className={`zero-dialog-enter-content flex min-h-0 flex-col overflow-hidden bg-background text-foreground shadow-[0_24px_70px_rgba(0,0,0,0.30)] transition-transform duration-[180ms] ease ${
          visible ? "translate-y-0" : "translate-y-2"
        } ${
          fullscreen
            ? "h-dvh w-dvw rounded-none"
            : "h-[min(700px,86vh)] w-[min(980px,92vw)] rounded-2xl"
        }`}
        data-testid="attachment-lightbox-panel"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{filename}</div>
            <div className="truncate text-xs text-muted-foreground">
              {subtitle}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ArtifactShareButton
              ariaLabel="Share"
              iconSize={18}
              url={preview.url}
            />
            <ArtifactDownloadMenu
              ariaLabel="Download options"
              filename={filename}
              iconSize={18}
              syncTarget={syncTarget}
              url={preview.url}
            />
            <ArtifactActionSeparator />
            <ArtifactDialogSplitViewButton onClick={openInSplitView} />
            <ArtifactDialogFullscreenButton
              fullscreen={fullscreen}
              onClick={() => {
                resetDialogImageZoom(!fullscreen);
                toggleLightboxDialogFullscreen();
              }}
            />
            <DialogIconButton
              ariaLabel="Close"
              onClick={() => {
                closeWithAnimation();
              }}
            >
              <IconX size={18} stroke={1.8} />
            </DialogIconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 bg-background">
          <ArtifactDialogBody pageSignal={pageSignal} preview={preview} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function AttachmentLightbox() {
  const preview = useGet(lightboxUrl$);
  const sidebarEnabled = useGet(chatArtifactSidebarEnabled$);
  const dialogRef = useSet(lightboxDialogRef$);
  const closeLightbox = useSet(closeLightbox$);
  const pageSignal = useGet(pageSignal$);

  if (!preview) {
    return null;
  }

  if (sidebarEnabled) {
    return <ArtifactPreviewDialog preview={preview} />;
  }

  if (preview.kind === "image") {
    return <ImageLightbox url={preview.url} />;
  }

  if (preview.kind === "video") {
    return <VideoLightbox filename={preview.filename} url={preview.url} />;
  }

  if (preview.kind === "audio") {
    return <AudioLightbox filename={preview.filename} url={preview.url} />;
  }

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeLightbox();
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={ATTACHMENT_LIGHTBOX_OVERLAY_CLASS}
      style={{ pointerEvents: "auto" }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      data-testid="attachment-lightbox"
    >
      <LightboxBodyScrollLock />
      <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            detach(
              copyAttachmentLinkToClipboard(preview.url),
              Reason.DomCallback,
              "attachment copy link",
            );
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
          aria-label="Share"
        >
          <IconShare size={20} stroke={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            detach(
              downloadAttachmentUrl(preview.url, pageSignal),
              Reason.DomCallback,
              "attachment download",
            );
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors cursor-pointer"
          aria-label="Download"
        >
          <IconDownload size={20} stroke={2} />
        </button>
        <button
          type="button"
          onClick={() => {
            closeLightbox();
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          aria-label="Close"
        >
          <IconX size={20} stroke={2} />
        </button>
      </div>
      <div
        className={`relative z-10 w-[min(92vw,1100px)] min-w-0 overflow-hidden rounded-2xl bg-background shadow-2xl ${ATTACHMENT_LIGHTBOX_PANEL_CLASS}`}
        data-testid="attachment-lightbox-panel"
      >
        <div className="flex items-center gap-3 border-b border-foreground/10 px-4 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
            <FilePreviewIcon
              filename={preview.filename}
              contentType={contentTypeForDocumentAttachmentPreviewKind(
                preview.kind,
              )}
              testId="attachment-lightbox-file-icon"
            />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {preview.filename}
            </div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              {preview.kind} preview
            </div>
          </div>
        </div>
        {preview.kind === "markdown" ? (
          <MarkdownLightboxBody url={preview.url} signal={pageSignal} />
        ) : preview.kind === "text" || preview.kind === "json" ? (
          <PlainTextLightboxBody
            url={preview.url}
            kind={preview.kind}
            signal={pageSignal}
          />
        ) : preview.kind === "csv" ? (
          <CsvLightboxBody url={preview.url} signal={pageSignal} />
        ) : (
          <div className="max-w-full overflow-hidden overscroll-contain bg-background">
            <iframe
              src={preview.url}
              title={`${preview.filename} preview`}
              sandbox={preview.kind === "html" ? "allow-scripts" : undefined}
              scrolling="yes"
              className="relative z-10 block h-[min(78vh,900px)] w-full max-w-full overflow-x-hidden overscroll-contain bg-background"
            />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function MarkdownLightboxBody({
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
            <div className="flex h-[min(78vh,900px)] items-center justify-center p-6 text-muted-foreground">
              <IconLoader2 size={20} className="animate-spin" />
            </div>
          );
        }

        if (status === "error") {
          return (
            <div className="flex h-[min(78vh,900px)] items-center justify-center p-6 text-sm text-muted-foreground">
              Markdown preview unavailable.
            </div>
          );
        }

        return (
          <div className="h-[min(78vh,900px)] overflow-auto p-6">
            <Markdown source={text} />
          </div>
        );
      }}
    </TextPreviewLoader>
  );
}

function PlainTextLightboxBody({
  kind,
  signal,
  url,
}: {
  kind: "text" | "json" | "csv";
  signal: AbortSignal;
  url: string;
}) {
  return (
    <TextPreviewLoader url={url} signal={signal}>
      {({ status, text }) => {
        if (status === "loading") {
          return (
            <div className="flex h-[min(78vh,900px)] items-center justify-center p-6 text-muted-foreground">
              <IconLoader2 size={20} className="animate-spin" />
            </div>
          );
        }

        if (status === "error") {
          return (
            <div className="flex h-[min(78vh,900px)] items-center justify-center p-6 text-sm text-muted-foreground">
              {kind === "json" ? "JSON" : kind === "csv" ? "CSV" : "Text"}{" "}
              preview unavailable.
            </div>
          );
        }

        const trimmed = formatPlainPreviewText(kind, text);
        const display =
          trimmed.length > 16_000
            ? `${trimmed.slice(0, 16_000)}\n\n…`
            : trimmed;

        return (
          <div className="h-[min(78vh,900px)] overflow-auto p-6">
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-4 text-sm text-foreground">
              {display}
            </pre>
          </div>
        );
      }}
    </TextPreviewLoader>
  );
}

function CsvLightboxBody({
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
            <div className="flex h-[min(78vh,900px)] items-center justify-center p-6 text-muted-foreground">
              <IconLoader2 size={20} className="animate-spin" />
            </div>
          );
        }

        if (status === "error") {
          return (
            <div className="flex h-[min(78vh,900px)] items-center justify-center p-6 text-sm text-muted-foreground">
              CSV preview unavailable.
            </div>
          );
        }

        const rows = parseCsvRows(text);
        if (rows.length === 0) {
          return (
            <div className="flex h-[min(78vh,900px)] items-center justify-center p-6 text-sm text-muted-foreground">
              CSV preview unavailable.
            </div>
          );
        }

        return (
          <div className="h-[min(78vh,900px)] overflow-auto p-6">
            <CsvPreviewTable rows={rows} />
          </div>
        );
      }}
    </TextPreviewLoader>
  );
}

// ---------------------------------------------------------------------------
// FileAttachmentChip — compact chip shown inside sent message bubbles
// ---------------------------------------------------------------------------

// Shared visual shape for file attachment chips. Keeps a fixed h-7 (28px)
// height regardless of upload state, with the filename always visible and
// truncated with an ellipsis past max-w-[240px].
const FILE_CHIP_CLASSES =
  "inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md border border-foreground/15 bg-background/80 px-1.5 transition-colors";

function FileChipBody({
  filename,
  contentType,
  testId,
}: {
  filename: string;
  contentType?: string;
  testId: string;
}) {
  return (
    <>
      <FilePreviewIcon
        filename={filename}
        contentType={contentType}
        size="sm"
        className="shrink-0"
        testId={testId}
      />
      <span className="min-w-0 truncate text-xs font-medium">{filename}</span>
    </>
  );
}

export function FileAttachmentChip({
  contentType,
  filename,
  url,
}: {
  contentType?: string;
  filename: string;
  url: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        detach(
          downloadAttachmentUrl(url, undefined, filename),
          Reason.DomCallback,
          "attachment download",
        );
      }}
      title={filename}
      aria-label={`Download ${filename}`}
      className={`${FILE_CHIP_CLASSES} hover:bg-foreground/10`}
    >
      <FileChipBody
        filename={filename}
        contentType={contentType}
        testId="attachment-chip-file-icon"
      />
    </button>
  );
}

export function PreviewableFileAttachmentChip({
  filename,
  url,
  kind,
}: {
  filename: string;
  url: string;
  kind: "markdown" | "text" | "json" | "csv" | "pdf" | "html";
}) {
  const openDocumentLightbox = useSet(openDocumentLightbox$);

  return (
    <button
      type="button"
      onClick={() => {
        openDocumentLightbox({ kind, url, filename });
      }}
      title={filename}
      aria-label={`Open ${kind} preview for ${filename}`}
      className={`${FILE_CHIP_CLASSES} hover:bg-foreground/10`}
    >
      <FileChipBody
        filename={filename}
        contentType={contentTypeForDocumentAttachmentPreviewKind(kind)}
        testId="attachment-chip-file-icon"
      />
    </button>
  );
}

export function PreviewableAudioAttachmentChip({
  contentType,
  filename,
  url,
}: {
  contentType?: string;
  filename: string;
  url: string;
}) {
  const openAudioLightbox = useSet(openAudioLightbox$);

  return (
    <button
      type="button"
      onClick={() => {
        openAudioLightbox({ url, filename });
      }}
      title={filename}
      aria-label={`Open audio preview for ${filename}`}
      className={`${FILE_CHIP_CLASSES} hover:bg-foreground/10`}
    >
      <FileChipBody
        filename={filename}
        contentType={contentType}
        testId="attachment-chip-file-icon"
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// AttachmentChip — chip shown in the composer before the message is sent
// ---------------------------------------------------------------------------

function ComposerImagePreviewButton({
  filename,
  openImageLightbox,
  url,
}: {
  filename: string;
  openImageLightbox: (url: string) => void;
  url: string | undefined;
}) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageLoadKey = url ? `composer-image:${url}` : null;

  const currentImageStatus = imageLoadKey
    ? (imageLoadStatuses[imageLoadKey] ?? "loading")
    : "loading";

  if (!url || !imageLoadKey) {
    return (
      <button
        type="button"
        disabled
        aria-label={`Open image preview for ${filename}`}
        title={filename}
        className="group/image-preview relative h-9 w-9 overflow-hidden rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
      >
        <IconPhoto
          size={20}
          stroke={1.5}
          className="text-muted-foreground m-auto h-full"
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        openImageLightbox(url);
      }}
      aria-label={`Open image preview for ${filename}`}
      title={filename}
      className="group/image-preview relative h-9 w-9 overflow-hidden rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
    >
      {currentImageStatus !== "loaded" && (
        <span
          data-testid="composer-image-preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-muted/70 text-muted-foreground"
        >
          {currentImageStatus === "loading" ? (
            <IconLoader2 size={14} stroke={1.8} className="animate-spin" />
          ) : (
            <IconPhoto size={16} stroke={1.5} />
          )}
        </span>
      )}
      <img
        key={imageLoadKey}
        ref={imageLoadStatusRef}
        src={url}
        alt=""
        data-image-load-key={imageLoadKey}
        loading="lazy"
        onLoad={() => {
          setImageLoadStatus(imageLoadKey, "loaded");
        }}
        onError={() => {
          setImageLoadStatus(imageLoadKey, "error");
        }}
        className={`h-full w-full object-cover ${
          currentImageStatus === "loaded" ? "" : "opacity-0"
        }`}
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/image-preview:bg-black/30">
        <IconPhoto
          size={18}
          className="text-white opacity-0 drop-shadow transition-opacity group-hover/image-preview:opacity-100"
        />
      </span>
    </button>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ZeroChatAttachment;
  onRemove: () => void;
}) {
  const infoLoadable = useLoadable(attachment.fileInfo$);
  const uploading = infoLoadable.state === "loading";
  const url =
    infoLoadable.state === "hasData" ? infoLoadable.data?.url : undefined;
  const openImageLightbox = useSet(openImageLightbox$);
  const isImage = attachment.contentType.startsWith("image/");
  return (
    <div
      className="relative inline-flex items-center"
      title={attachment.filename}
    >
      {isImage ? (
        <ComposerImagePreviewButton
          filename={attachment.filename}
          openImageLightbox={openImageLightbox}
          url={url}
        />
      ) : (
        <span className={FILE_CHIP_CLASSES}>
          <FileChipBody
            filename={attachment.filename}
            contentType={attachment.contentType}
            testId="composer-attachment-file-icon"
          />
        </span>
      )}
      {uploading && (
        <span className="absolute -top-1 -left-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
          <IconLoader2
            size={10}
            className="animate-spin text-muted-foreground"
          />
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors"
        aria-label={
          uploading
            ? `Cancel upload ${attachment.filename}`
            : `Remove ${attachment.filename}`
        }
      >
        <IconX size={9} stroke={2.5} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttachmentChips — wrapper that renders a list of AttachmentChip items
// ---------------------------------------------------------------------------

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: ZeroChatAttachment[];
  onRemove: (attachment: ZeroChatAttachment) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3">
      {attachments.map((a) => {
        return (
          <AttachmentChip
            key={String(a.fileInfo$)}
            attachment={a}
            onRemove={() => {
              return onRemove(a);
            }}
          />
        );
      })}
    </div>
  );
}
