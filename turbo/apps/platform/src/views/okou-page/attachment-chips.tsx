import type { MouseEvent, ReactNode } from "react";
import { Button, Dialog, DialogContent, cn } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  FileMusic,
  Image,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatAttachment } from "../../signals/okou-page/chat-draft";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";
import { resetZoomableImageCanvasZoom$ } from "../../signals/view-component-state.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import type { TextPreviewComputed } from "../../signals/text-preview.ts";
import type { MarkdownPreviewTreeComputed } from "../../signals/markdown-preview-tree.ts";
import { retryRichMarkdown$ } from "../../signals/rich-markdown-retry.ts";
import { MarkdownEventBody } from "../components/markdown.tsx";
import {
  attachmentSidebarRef,
  lightboxUrl$,
  closeLightboxImmediately$,
  closeLightboxWithDialogExit$,
  lightboxDialogFullscreen$,
  lightboxDialogVisible$,
  lightboxDialogMountRef$,
  navigateImageLightbox$,
  openAudioLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  toggleLightboxDialogFullscreen$,
  type AttachmentArtifactMetadata,
  type AttachmentLightboxState,
} from "../../signals/okou-page/attachment-chips.ts";
import { openThreadArtifactSplitView$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { closeArtifactCatalogPreview$ } from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import {
  artifactPreviewUrlsMatch,
  attachmentFilenameFromUrl,
} from "./attachment-url.ts";
import { AnnotationMarkLayer } from "./image-annotation-marks.tsx";
import {
  annotationMarkCount,
  DEFAULT_ANNOTATION_INK,
  openAnnotationEditor$,
} from "../../signals/okou-page/image-annotation.ts";
import { composerImageAnnotationEnabled$ } from "../../signals/external/feature-switch.ts";
import { useResolvedAttachmentUrl } from "./attachment-resource.ts";
import {
  ArtifactActionSeparator,
  ArtifactDownloadMenu,
  ArtifactShareButton,
  type ArtifactDownloadSyncTarget,
} from "./artifact-actions.tsx";
import {
  artifactFallbackSubtitle,
  artifactTitleSubtitle,
} from "./artifact-display.ts";
import {
  currentEventImageArtifactNavigation,
  equalEventImageGroups,
  type ImageArtifactNavigationItem,
  shouldIgnoreImageArtifactNavigationKey,
} from "./artifact-image-navigation.ts";
import {
  ZoomableArtifactImageCanvas,
  type ZoomableImageControls,
  zoomableArtifactImageKey,
} from "./zoomable-image-canvas.tsx";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import { PresentationArtifactViewport } from "./presentation-artifact-viewport.tsx";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

type TextPreviewLoadState = {
  readonly status: "loading" | "loaded" | "error";
  readonly text: string;
};

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

// ---------------------------------------------------------------------------
// AttachmentLightbox — full-screen attachment viewer
// ---------------------------------------------------------------------------

export function TextPreviewLoader({
  text$,
  children,
}: {
  text$: TextPreviewComputed;
  children: (state: TextPreviewLoadState) => ReactNode;
}) {
  const loadable = useLoadable(text$);
  if (loadable.state === "hasData") {
    return children({ status: "loaded", text: loadable.data });
  }
  if (loadable.state === "hasError") {
    return children({ status: "error", text: "" });
  }
  return children({ status: "loading", text: "" });
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
    <Button
      showTooltip
      type="button"
      onClick={onClick}
      variant="quiet"
      size="icon-sm"
      className="shrink-0"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {children}
    </Button>
  );
}

function ArtifactDialogSplitViewButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <DialogIconButton
      ariaLabel={t(($) => {
        return $.artifacts.actions.openSplitView;
      })}
      onClick={onClick}
    >
      <Columns2 size={18} />
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
  const { t } = useTranslation();
  return (
    <DialogIconButton
      ariaLabel={
        fullscreen
          ? t(($) => {
              return $.artifacts.actions.exitFullscreen;
            })
          : t(($) => {
              return $.artifacts.actions.enterFullscreen;
            })
      }
      onClick={onClick}
    >
      {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
    </DialogIconButton>
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

type ArtifactImageNavigationActions = {
  readonly onNext?: () => void;
  readonly onPrevious?: () => void;
};

function artifactDialogKindLabel(
  preview: AttachmentLightboxState,
  artifact: AttachmentArtifactMetadata | undefined,
): string {
  if (artifact) {
    return artifactTitleSubtitle(preview.kind, artifact, {
      showSize: preview.showSizeInSubtitle ?? true,
    });
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
    disconnected: artifact.googleDriveDisconnected,
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
      return (
        artifactPreviewUrlsMatch(candidate.url, url) ||
        (candidate.aliasUrl !== undefined &&
          artifactPreviewUrlsMatch(candidate.aliasUrl, url))
      );
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
    artifactKind: params.item.file.artifactKind,
    contentType: params.item.file.contentType,
    createdAt: params.item.file.createdAt,
    fileId: params.item.file.id,
    filename: params.item.file.filename,
    googleDriveDisconnected:
      params.item.file.googleDriveSync?.status === "disconnected",
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
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}

function ArtifactDialogUnavailableBody({
  label,
  onRetry,
}: {
  label: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      <span>
        {t(
          ($) => {
            return $.artifacts.preview.unavailable;
          },
          { kind: label },
        )}
      </span>
      {onRetry !== undefined && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(($) => {
            return $.chat.errors.recovery.tryAgain;
          })}
        </Button>
      )}
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
  const { t } = useTranslation();
  return (
    <div
      className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg bg-background/95 px-2.5 py-1.5 text-muted-foreground shadow-sm backdrop-blur-sm"
      data-testid="artifact-dialog-image-zoom-controls"
    >
      <button
        type="button"
        onClick={controls.zoomOut}
        disabled={!controls.canZoomOut}
        className="flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label={t(($) => {
          return $.artifacts.actions.zoomOut;
        })}
        title={t(($) => {
          return $.artifacts.actions.zoomOut;
        })}
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
        className="flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label={t(($) => {
          return $.artifacts.actions.zoomIn;
        })}
        title={t(($) => {
          return $.artifacts.actions.zoomIn;
        })}
      >
        +
      </button>
      <button
        type="button"
        onClick={controls.resetZoom}
        className="flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-state-hover hover:text-foreground"
        aria-label={t(($) => {
          return $.artifacts.actions.resetZoom;
        })}
        title={t(($) => {
          return $.artifacts.actions.resetZoom;
        })}
      >
        <RotateCcw size={15} />
      </button>
    </div>
  );
}

function ArtifactDialogImageNavigationControls({
  navigation,
}: {
  navigation?: ArtifactImageNavigationActions;
}) {
  const { t } = useTranslation();
  if (!navigation?.onPrevious && !navigation?.onNext) {
    return null;
  }

  return (
    <>
      {navigation.onPrevious && (
        <Button
          showTooltip
          type="button"
          onClick={navigation.onPrevious}
          aria-label={t(($) => {
            return $.artifacts.actions.previousImage;
          })}
          title={t(($) => {
            return $.artifacts.actions.previousImage;
          })}
          data-testid="artifact-dialog-previous-image"
          variant="quiet"
          size="icon-lg"
          className="absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm [&_svg]:size-[22px]"
        >
          <ChevronLeft size={22} />
        </Button>
      )}
      {navigation.onNext && (
        <Button
          showTooltip
          type="button"
          onClick={navigation.onNext}
          aria-label={t(($) => {
            return $.artifacts.actions.nextImage;
          })}
          title={t(($) => {
            return $.artifacts.actions.nextImage;
          })}
          data-testid="artifact-dialog-next-image"
          variant="quiet"
          size="icon-lg"
          className="absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm [&_svg]:size-[22px]"
        >
          <ChevronRight size={22} />
        </Button>
      )}
    </>
  );
}

function ArtifactDialogImageNavigationKeydown({
  navigation,
}: {
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
          // The lightbox modal is an immersive overlay: arrow keys always
          // navigate, regardless of focus.
          if (
            shouldIgnoreImageArtifactNavigationKey(event, {
              considerFocus: false,
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

        document.addEventListener("keydown", onKeyDown, true);
        cleanup = () => {
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }}
      hidden
    />
  );
}

function ArtifactDialogMarkdownBody({
  tree$,
}: {
  tree$: MarkdownPreviewTreeComputed;
}) {
  const { t } = useTranslation();
  const retry = useSet(retryRichMarkdown$);
  const loadable = useLoadable(tree$);
  if (loadable.state === "loading") {
    return (
      <ArtifactDialogStage>
        <ArtifactDialogCard>
          <ArtifactDialogLoadingBody />
        </ArtifactDialogCard>
      </ArtifactDialogStage>
    );
  }
  if (loadable.state === "hasError") {
    return (
      <ArtifactDialogStage>
        <ArtifactDialogCard>
          <ArtifactDialogUnavailableBody
            label={t(($) => {
              return $.artifacts.kinds.markdown;
            })}
            onRetry={retry}
          />
        </ArtifactDialogCard>
      </ArtifactDialogStage>
    );
  }
  return (
    <ArtifactDialogStage>
      <ArtifactDialogCard>
        <div className="h-full overflow-auto p-6">
          <MarkdownEventBody tree={loadable.data} mediaPreview={false} />
        </div>
      </ArtifactDialogCard>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogTextBody({
  kind,
  text$,
}: {
  kind: "text" | "json" | "csv";
  text$: TextPreviewComputed;
}) {
  const { t } = useTranslation();
  const kindLabel =
    kind === "json"
      ? t(($) => {
          return $.artifacts.kinds.json;
        })
      : kind === "csv"
        ? t(($) => {
            return $.artifacts.kinds.csv;
          })
        : t(($) => {
            return $.artifacts.kinds.text;
          });
  return (
    <TextPreviewLoader text$={text$}>
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
                <ArtifactDialogUnavailableBody label={kindLabel} />
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
                      {t(
                        ($) => {
                          return $.artifacts.preview.unavailable;
                        },
                        {
                          kind: kindLabel,
                        },
                      )}
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

function ArtifactDialogImageStage({
  filename,
  imageNavigation,
  preview,
  resourceUrl,
}: {
  filename: string;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: Extract<AttachmentLightboxState, { kind: "image" }>;
  resourceUrl: string | null;
}) {
  const fullscreen = useGet(lightboxDialogFullscreen$);
  // Marks live on the draft rather than in the file, so the viewer has to draw
  // them too — otherwise reopening an annotated image shows a clean picture.
  const annotation = preview.annotationTarget?.annotation ?? null;

  return (
    <ArtifactDialogStage flush scrollable={false}>
      <ArtifactDialogCard fillHeight>
        <div className="relative h-full min-h-0">
          {resourceUrl === null ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="animate-spin" />
            </div>
          ) : (
            <ZoomableArtifactImageCanvas
              src={resourceUrl}
              alt={filename}
              zoomKey={artifactDialogImageZoomKey(preview.url, fullscreen)}
              imageTestId="attachment-lightbox-image"
              contentClassName="p-6"
              imageClassName="rounded-lg shadow-sm"
              canvasTestId="artifact-dialog-image-stage"
              overlay={
                annotation ? (
                  <AnnotationMarkLayer annotation={annotation} />
                ) : undefined
              }
            >
              {(controls) => {
                return <ArtifactDialogImageZoomControls controls={controls} />;
              }}
            </ZoomableArtifactImageCanvas>
          )}
          <ArtifactDialogImageNavigationControls navigation={imageNavigation} />
        </div>
      </ArtifactDialogCard>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogImageBody({
  filename,
  imageNavigation,
  preview,
}: {
  filename: string;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: Extract<AttachmentLightboxState, { kind: "image" }>;
}) {
  const resourceUrl = useResolvedAttachmentUrl(preview.url);
  return (
    <ArtifactDialogImageStage
      filename={filename}
      imageNavigation={imageNavigation}
      preview={preview}
      resourceUrl={resourceUrl}
    />
  );
}

function ArtifactDialogVideoBody({
  filename,
  preview,
}: {
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resourceUrl = useResolvedAttachmentUrl(preview.url);

  return (
    <ArtifactDialogStage centered>
      <div
        className="w-full overflow-hidden rounded-xl border border-border/70 bg-black shadow-sm"
        data-testid="artifact-dialog-video-stage"
      >
        {resourceUrl !== null && (
          <video
            src={resourceUrl}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="block aspect-video w-full bg-black object-contain"
            aria-label={t(
              ($) => {
                return $.artifacts.preview.videoLabel;
              },
              { filename },
            )}
          />
        )}
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogAudioBody({
  filename,
  preview,
}: {
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resourceUrl = useResolvedAttachmentUrl(preview.url);

  return (
    <ArtifactDialogStage centered>
      <div className="flex w-full max-w-[520px] flex-col items-center gap-4 rounded-xl border border-border/70 bg-background p-6 shadow-sm">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/70 bg-muted/50 text-muted-foreground">
          <FileMusic size={28} />
        </span>
        <p className="max-w-full truncate text-sm text-muted-foreground">
          {filename}
        </p>
        {resourceUrl !== null && (
          <audio
            src={resourceUrl}
            controls
            autoPlay
            preload="metadata"
            className="w-full"
            aria-label={t(
              ($) => {
                return $.artifacts.preview.audioLabel;
              },
              { filename },
            )}
            data-testid="artifact-dialog-audio"
          />
        )}
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogDocumentFrameBody({
  filename,
  preview,
}: {
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resourceUrl = useResolvedAttachmentUrl(preview.url);
  // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail so the
  // embedded preview shows just the page and toolbar by default.
  const src =
    resourceUrl !== null && preview.kind === "pdf"
      ? `${resourceUrl}#navpanes=0`
      : resourceUrl;

  return (
    <ArtifactDialogStage scrollable={false}>
      <div
        className="flex h-full min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm"
        data-testid="artifact-dialog-document-frame"
      >
        {src !== null && (
          <iframe
            src={src}
            title={t(
              ($) => {
                return $.artifacts.preview.dialogLabel;
              },
              { filename },
            )}
            scrolling="yes"
            className="block h-full min-h-0 w-full border-0 bg-background"
          />
        )}
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogGenericFileBody({ filename }: { filename: string }) {
  const { t } = useTranslation();
  return (
    <ArtifactDialogStage centered>
      <div className="flex w-full max-w-md flex-col items-center justify-center gap-3 rounded-xl border border-border/70 bg-background p-6 text-center text-muted-foreground shadow-sm">
        <p className="text-sm">
          {t(($) => {
            return $.artifacts.preview.noInline;
          })}
        </p>
        <p className="text-xs">{filename}</p>
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogBody({
  artifact,
  imageNavigation,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: AttachmentLightboxState;
}) {
  const filename = artifactDialogFilename(preview);

  if (preview.kind === "image") {
    return (
      <ArtifactDialogImageBody
        filename={filename}
        imageNavigation={imageNavigation}
        preview={preview}
      />
    );
  }

  if (preview.kind === "video") {
    return <ArtifactDialogVideoBody filename={filename} preview={preview} />;
  }

  if (preview.kind === "audio") {
    return <ArtifactDialogAudioBody filename={filename} preview={preview} />;
  }

  if (preview.kind === "file") {
    return <ArtifactDialogGenericFileBody filename={filename} />;
  }

  if (preview.kind === "markdown") {
    return <ArtifactDialogMarkdownBody tree$={preview.markdownTree$} />;
  }
  if (
    preview.kind === "text" ||
    preview.kind === "json" ||
    preview.kind === "csv"
  ) {
    return <ArtifactDialogTextBody kind={preview.kind} text$={preview.text$} />;
  }

  if (preview.kind === "html") {
    return (
      <ArtifactDialogHtmlBody
        artifact={artifact}
        filename={filename}
        preview={preview}
      />
    );
  }

  return (
    <ArtifactDialogDocumentFrameBody filename={filename} preview={preview} />
  );
}

function ArtifactDialogHtmlBody({
  artifact,
  filename,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const fullscreen = useGet(lightboxDialogFullscreen$);
  const src = useResolvedAttachmentUrl(preview.url);
  const isPresentationHtml = artifact?.artifactKind === "presentation-html";

  if (src === null) {
    return (
      <div
        className="h-full w-full bg-background"
        data-testid="artifact-dialog-site-frame"
      />
    );
  }

  const frame = (
    <AutoFocusedArtifactIframe
      focusKey={`${preview.url}:${fullscreen ? "fullscreen" : "dialog"}`}
      focusOnMount={!isPresentationHtml}
      src={src}
      title={t(
        ($) => {
          return $.artifacts.preview.dialogLabel;
        },
        { filename },
      )}
      sandbox="allow-same-origin allow-scripts"
      tabIndex={isPresentationHtml ? -1 : undefined}
      scrolling="yes"
      className="block h-full w-full border-0 bg-background"
      data-testid="artifact-dialog-body-html"
    />
  );

  return (
    <div
      className="h-full w-full bg-background"
      data-testid="artifact-dialog-site-frame"
    >
      {isPresentationHtml ? (
        <PresentationArtifactViewport>{frame}</PresentationArtifactViewport>
      ) : (
        frame
      )}
    </div>
  );
}

function ArtifactPreviewDialog({
  preview,
}: {
  preview: AttachmentLightboxState;
}) {
  const leftThread = useLastResolved(currentLeftThread$);
  const rightThread = useLastResolved(currentRightThread$);
  const previewThreadId =
    (preview.kind === "image" ? preview.threadId : undefined) ??
    preview.artifact?.threadId;
  const previewThread =
    leftThread?.threadId === previewThreadId
      ? leftThread
      : rightThread?.threadId === previewThreadId
        ? rightThread
        : undefined;

  if (previewThread) {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={previewThread}
      />
    );
  }

  if (previewThreadId) {
    return (
      <ArtifactPreviewDialogContent
        artifact={preview.artifact}
        preview={preview}
      />
    );
  }

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
  fallbackThread?: ChatPanelSignals;
  preview: AttachmentLightboxState;
  thread: ChatPanelSignals;
}) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = thread.agentId;
  const eventGroups = useLastResolved(thread.eventImageGroups$, {
    equalityFn: equalEventImageGroups,
  });
  const navigateImageLightbox = useSet(navigateImageLightbox$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const item =
    loadable.state === "hasData"
      ? findArtifactDialogItemForUrl(loadable.data, preview.url)
      : undefined;
  const resolvedImageNavigation =
    preview.kind === "image"
      ? currentEventImageArtifactNavigation(
          loadable.state === "hasData" ? loadable.data : [],
          eventGroups ?? [],
          preview.url,
        )
      : {};
  const imageNavigation =
    resolvedImageNavigation.role === "assistant" || loadable.state === "hasData"
      ? resolvedImageNavigation
      : {};
  const openImageNavigationItem = (
    navigationItem: ImageArtifactNavigationItem,
  ) => {
    navigateImageLightbox({
      artifact: navigationItem.artifact
        ? artifactDialogMetadataFromItem({
            agentId,
            item: navigationItem.artifact,
            onSyncSuccess: () => {
              reloadArtifacts();
            },
            threadId: thread.threadId,
          })
        : undefined,
      filename: navigationItem.filename,
      threadId: thread.threadId,
      url: navigationItem.url,
    });
  };
  const imageNavigationAction = (
    navigationItem: ImageArtifactNavigationItem | undefined,
  ) => {
    if (!navigationItem) {
      return undefined;
    }
    return () => {
      openImageNavigationItem(navigationItem);
    };
  };

  if (item) {
    return (
      <ArtifactPreviewDialogContent
        artifact={artifactDialogMetadataFromItem({
          agentId,
          item,
          onSyncSuccess: () => {
            reloadArtifacts();
          },
          threadId: thread.threadId,
        })}
        imageNavigation={{
          onNext: imageNavigationAction(imageNavigation.next),
          onPrevious: imageNavigationAction(imageNavigation.previous),
        }}
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

  // The previewed image is not a run artifact (e.g. a human-uploaded image that
  // resolves from the user artifacts bucket). It still navigates among the other
  // images in its message.
  return (
    <ArtifactPreviewDialogContent
      artifact={preview.artifact}
      imageNavigation={{
        onNext: imageNavigationAction(imageNavigation.next),
        onPrevious: imageNavigationAction(imageNavigation.previous),
      }}
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

function ArtifactPreviewDialogActions({
  artifact,
  fullscreen,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  fullscreen: boolean;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const closeLightboxWithDialogExit = useSet(closeLightboxWithDialogExit$);
  const closeArtifactCatalogPreview = useSet(closeArtifactCatalogPreview$);
  const openArtifactSidebarPreview = useSet(openThreadArtifactSplitView$);
  const resetZoomableImageCanvasZoom = useSet(resetZoomableImageCanvasZoom$);
  const toggleLightboxDialogFullscreen = useSet(
    toggleLightboxDialogFullscreen$,
  );
  const showShare = preview.shareAvailable !== false;
  const showSplitView = preview.splitViewAvailable !== false;
  const openAnnotationEditor = useSet(openAnnotationEditor$);
  const closeLightboxImmediately = useSet(closeLightboxImmediately$);
  const annotationTarget =
    preview.kind === "image" ? preview.annotationTarget : undefined;
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
    openArtifactSidebarPreview(attachmentSidebarRef(preview));
    closeLightboxWithDialogExit(rootSignal);
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      {annotationTarget && (
        <Button
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          data-testid="artifact-dialog-annotate"
          aria-label={t(($) => {
            return $.artifacts.annotation.open;
          })}
          title={t(($) => {
            return $.artifacts.annotation.open;
          })}
          onClick={() => {
            // The editor owns the whole surface while it is open, so the
            // read-only viewer steps aside — instantly, or the two dialogs
            // cross-fade and the modal appears to jump.
            openAnnotationEditor(annotationTarget);
            closeLightboxImmediately();
          }}
        >
          <Pencil size={18} />
        </Button>
      )}
      {showShare && (
        <ArtifactShareButton
          ariaLabel={t(($) => {
            return $.artifacts.actions.share;
          })}
          iconSize={18}
          url={preview.url}
        />
      )}
      <ArtifactDownloadMenu
        ariaLabel={t(($) => {
          return $.artifacts.actions.downloadOptions;
        })}
        artifactKind={artifact?.artifactKind}
        filename={artifact?.filename ?? artifactDialogFilename(preview)}
        iconSize={18}
        menuInstanceKey="artifact-dialog"
        syncTarget={artifactDialogSyncTarget(artifact)}
        url={preview.url}
      />
      <ArtifactActionSeparator />
      {showSplitView && (
        <ArtifactDialogSplitViewButton onClick={openInSplitView} />
      )}
      <ArtifactDialogFullscreenButton
        fullscreen={fullscreen}
        onClick={() => {
          resetDialogImageZoom(!fullscreen);
          toggleLightboxDialogFullscreen();
        }}
      />
      <DialogIconButton
        ariaLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        onClick={() => {
          closeArtifactCatalogPreview(rootSignal);
        }}
      >
        <X size={18} />
      </DialogIconButton>
    </div>
  );
}

function ArtifactPreviewDialogContent({
  artifact,
  imageNavigation,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const dialogMountRef = useSet(lightboxDialogMountRef$);
  const closeArtifactCatalogPreview = useSet(closeArtifactCatalogPreview$);
  const filename = artifact?.filename ?? artifactDialogFilename(preview);
  const subtitle = artifactDialogKindLabel(preview, artifact);
  const visible = useGet(lightboxDialogVisible$);
  const fullscreen = useGet(lightboxDialogFullscreen$);

  const closeWithAnimation = () => {
    closeArtifactCatalogPreview(rootSignal);
  };

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeWithAnimation();
    }
  };

  return (
    <Dialog
      open={visible}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && visible) {
          closeWithAnimation();
        }
      }}
    >
      <DialogContent
        ref={dialogMountRef}
        showCloseButton={false}
        overlayClassName="zero-pwa-fixed-cover bg-gray-900/45 dark:bg-gray-900/45"
        className={cn(
          "zero-pwa-fixed-cover fixed inset-0 left-0 top-0 flex max-h-none w-auto max-w-none translate-x-0 translate-y-0 items-center justify-center gap-0 overflow-hidden rounded-none border-0 bg-transparent shadow-none",
          fullscreen ? "p-0" : "p-6",
        )}
        onClick={handleBackdropClick}
        aria-label={t(
          ($) => {
            return $.artifacts.preview.dialogLabel;
          },
          { filename },
        )}
        data-testid="attachment-lightbox"
      >
        <ArtifactDialogImageNavigationKeydown
          navigation={preview.kind === "image" ? imageNavigation : undefined}
        />
        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden bg-background text-foreground shadow-[0_24px_70px_rgba(0,0,0,0.30)]",
            fullscreen
              ? "zero-fixed-viewport-shell w-dvw rounded-none"
              : "h-[min(700px,86vh)] w-[min(980px,92vw)] rounded-xl",
          )}
          data-testid="attachment-lightbox-panel"
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{filename}</div>
              <div className="truncate text-xs text-muted-foreground">
                {subtitle}
              </div>
            </div>
            <ArtifactPreviewDialogActions
              artifact={artifact}
              fullscreen={fullscreen}
              preview={preview}
            />
          </div>
          <div className="min-h-0 flex-1 bg-background">
            <ArtifactDialogBody
              artifact={artifact}
              imageNavigation={imageNavigation}
              preview={preview}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AttachmentLightbox() {
  const preview = useGet(lightboxUrl$);

  if (!preview) {
    return null;
  }

  return <ArtifactPreviewDialog preview={preview} />;
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
  const { t } = useTranslation();
  const downloadAttachment = useSet(downloadAttachment$);
  const pageSignal = useGet(pageSignal$);
  return (
    <button
      type="button"
      onClick={() => {
        detach(
          downloadAttachment({ filename, url }, pageSignal),
          Reason.DomCallback,
          "attachment download",
        );
      }}
      title={filename}
      aria-label={t(
        ($) => {
          return $.artifacts.attachments.download;
        },
        { filename },
      )}
      className={`${FILE_CHIP_CLASSES} hover:bg-state-hover`}
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
  kind,
  shareAvailable,
  splitViewAvailable,
  text$,
  url,
}: {
  filename: string;
  kind: "markdown" | "text" | "json" | "csv" | "pdf" | "html";
  shareAvailable?: boolean;
  splitViewAvailable?: boolean;
  text$?: TextPreviewComputed;
  url: string;
}) {
  const { t } = useTranslation();
  const openDocumentLightbox = useSet(openDocumentLightbox$);
  const kindLabel =
    kind === "markdown"
      ? t(($) => {
          return $.artifacts.preview.openKinds.markdown;
        })
      : kind === "text"
        ? t(($) => {
            return $.artifacts.preview.openKinds.text;
          })
        : kind === "json"
          ? t(($) => {
              return $.artifacts.preview.openKinds.json;
            })
          : kind === "csv"
            ? t(($) => {
                return $.artifacts.preview.openKinds.csv;
              })
            : kind === "pdf"
              ? t(($) => {
                  return $.artifacts.preview.openKinds.pdf;
                })
              : t(($) => {
                  return $.artifacts.preview.openKinds.html;
                });

  return (
    <button
      type="button"
      onClick={() => {
        openDocumentLightbox({
          kind,
          url,
          filename,
          ...(shareAvailable === undefined ? {} : { shareAvailable }),
          ...(splitViewAvailable === undefined ? {} : { splitViewAvailable }),
          ...(text$ ? { text$ } : {}),
        });
      }}
      title={filename}
      aria-label={t(
        ($) => {
          return $.artifacts.preview.openKind;
        },
        {
          kind: kindLabel,
          filename,
        },
      )}
      className={`${FILE_CHIP_CLASSES} hover:bg-state-hover`}
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
  shareAvailable,
  splitViewAvailable,
  url,
}: {
  contentType?: string;
  filename: string;
  shareAvailable?: boolean;
  splitViewAvailable?: boolean;
  url: string;
}) {
  const { t } = useTranslation();
  const openAudioLightbox = useSet(openAudioLightbox$);

  return (
    <button
      type="button"
      onClick={() => {
        openAudioLightbox({
          url,
          filename,
          ...(shareAvailable === undefined ? {} : { shareAvailable }),
          ...(splitViewAvailable === undefined ? {} : { splitViewAvailable }),
        });
      }}
      title={filename}
      aria-label={t(
        ($) => {
          return $.artifacts.preview.openKind;
        },
        {
          kind: t(($) => {
            return $.artifacts.preview.openKinds.audio;
          }),
          filename,
        },
      )}
      className={`${FILE_CHIP_CLASSES} hover:bg-state-hover`}
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

/**
 * A restored attachment carries the canonical API URL, so the thumbnail needs
 * the same presigned exchange the sent message uses. Kept in its own component
 * so the surrounding button stays one DOM node across the pending-to-uploaded
 * transition, and the load key stays on the canonical URL, which is stable
 * across re-signing.
 */
function ComposerImagePreviewImage({
  load,
  loaded,
  url,
}: {
  load: ImageLoadSignals;
  loaded: boolean;
  url: string;
}) {
  const markLoaded = useSet(load.loaded$);
  const markFailed = useSet(load.failed$);
  const resolvedUrl = useResolvedAttachmentUrl(url);

  if (resolvedUrl === null) {
    return null;
  }

  return (
    <img
      key={url}
      src={resolvedUrl}
      alt=""
      loading="lazy"
      onLoad={markLoaded}
      onError={markFailed}
      className={`h-full w-full object-cover ${loaded ? "" : "opacity-0"}`}
    />
  );
}

function ComposerImagePreviewButton({
  filename,
  load,
  markCount,
  openImageLightbox,
  url,
}: {
  filename: string;
  load: ImageLoadSignals;
  markCount: number;
  openImageLightbox: (url: string) => void;
  url: string | undefined;
}) {
  const { t } = useTranslation();
  const currentImageStatus = useGet(load.status$);

  if (!url) {
    return (
      <button
        type="button"
        disabled
        aria-label={t(
          ($) => {
            return $.artifacts.attachments.openImagePreview;
          },
          {
            filename,
          },
        )}
        title={filename}
        className="group/image-preview relative h-9 w-9 overflow-hidden rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
      >
        <Image size={20} className="text-muted-foreground m-auto h-full" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        openImageLightbox(url);
      }}
      aria-label={t(
        ($) => {
          return $.artifacts.attachments.openImagePreview;
        },
        {
          filename,
        },
      )}
      title={filename}
      className="group/image-preview relative h-9 w-9 overflow-hidden rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
    >
      {currentImageStatus !== "loaded" && (
        <span
          data-testid="composer-image-preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-muted/70 text-muted-foreground"
        >
          {currentImageStatus === "loading" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Image size={16} />
          )}
        </span>
      )}
      <ComposerImagePreviewImage
        load={load}
        loaded={currentImageStatus === "loaded"}
        url={url}
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/image-preview:bg-black/30">
        <Image
          size={18}
          className="text-white opacity-0 drop-shadow transition-opacity group-hover/image-preview:opacity-100"
        />
      </span>
      {markCount > 0 && (
        <span
          data-testid="composer-attachment-mark-count"
          style={{ background: DEFAULT_ANNOTATION_INK }}
          className="absolute -bottom-0.5 -left-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border-[1.5px] border-background px-1 text-[9px] font-bold leading-none text-white"
        >
          {markCount}
        </span>
      )}
    </button>
  );
}

function AttachmentChip({
  attachment,
  onAnnotationChange,
  onRemove,
}: {
  attachment: ChatAttachment;
  onAnnotationChange: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const infoLoadable = useLoadable(attachment.fileInfo$);
  const uploading = infoLoadable.state === "loading";
  const url =
    infoLoadable.state === "hasData" ? infoLoadable.data?.url : undefined;
  const openImageLightbox = useSet(openImageLightbox$);
  const setAnnotation = useSet(attachment.setAnnotation$);
  const annotation = useGet(attachment.annotation$);
  const annotationEnabled = useGet(composerImageAnnotationEnabled$);
  const isImage = attachment.contentType.startsWith("image/");
  return (
    <div
      className="relative inline-flex items-center"
      title={attachment.filename}
    >
      {isImage ? (
        <ComposerImagePreviewButton
          filename={attachment.filename}
          load={attachment.imageLoad}
          markCount={annotationMarkCount(annotation)}
          openImageLightbox={(previewUrl) => {
            // A pending upload is not an artifact yet, so checking it must not
            // take over an open artifact sidebar.
            openImageLightbox({
              url: previewUrl,
              splitViewAvailable: false,
              ...(annotationEnabled
                ? {
                    annotationTarget: {
                      key: previewUrl,
                      filename: attachment.filename,
                      url: previewUrl,
                      annotation,
                      commit: (next) => {
                        // Writing the signal alone leaves the marks on this
                        // one in-memory object: nothing saves the draft, so a
                        // reload — or a draft sync that swaps the attachment
                        // out — loses every mark the user just drew.
                        setAnnotation(next);
                        onAnnotationChange();
                      },
                    },
                  }
                : {}),
            });
          }}
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
          <Loader2 size={10} className="animate-spin text-muted-foreground" />
        </span>
      )}
      <IconTooltipButton
        type="button"
        onClick={onRemove}
        className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors"
        aria-label={
          uploading
            ? t(
                ($) => {
                  return $.artifacts.attachments.cancelUpload;
                },
                {
                  filename: attachment.filename,
                },
              )
            : t(
                ($) => {
                  return $.artifacts.attachments.remove;
                },
                {
                  filename: attachment.filename,
                },
              )
        }
      >
        <X size={9} />
      </IconTooltipButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttachmentChips — wrapper that renders a list of AttachmentChip items
// ---------------------------------------------------------------------------

export function AttachmentChips({
  attachments,
  onAnnotationChange,
  onRemove,
}: {
  attachments: ChatAttachment[];
  onAnnotationChange: () => void;
  onRemove: (attachment: ChatAttachment) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3">
      {attachments.map((a) => {
        return (
          <AttachmentChip
            onAnnotationChange={onAnnotationChange}
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
