import type { MouseEvent, ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { createPortal } from "react-dom";
import {
  IconDownload,
  IconFile,
  IconFileMusic,
  IconPhoto,
  IconVideo,
  IconLoader2,
  IconZoomIn,
  IconZoomOut,
  IconZoomReset,
  IconX,
} from "@tabler/icons-react";
import type { ZeroChatAttachment } from "../../signals/chat-page/chat-message.ts";
import { logger } from "../../signals/log.ts";
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  imageLightboxImageRef$,
  imageLightboxKeyboardShortcutsRef$,
  imageLightboxState$,
  imageLoadStatusByKey$,
  imageLoadStatusRef$,
  resetImageLightboxZoom$,
  setImageLightboxStatus$,
  setImageLoadStatus$,
  textPreviewLoaderRef$,
  textPreviewLoadStateByKey$,
  type TextPreviewLoadState,
  zoomImageLightboxIn$,
  zoomImageLightboxOut$,
} from "../../signals/view-component-state.ts";
import { Markdown } from "../components/markdown.tsx";
import {
  lightboxUrl$,
  closeLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  lightboxDialogRef$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import docPdfIcon from "./assets/doc-pdf.svg";
import docDocIcon from "./assets/doc-doc.svg";
import docCsvIcon from "./assets/doc-csv.svg";
import docTxtIcon from "./assets/doc-txt.svg";
import docJsonIcon from "./assets/doc-json.svg";
import docHtmlIcon from "./assets/doc-html.svg";

const log = logger("zero-attachment-chips");

/**
 * Return the icon path for a known file extension, or null for unknown types.
 */
function getFileTypeIcon(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf": {
      return docPdfIcon;
    }
    case "doc":
    case "docx":
    case "odt":
    case "rtf":
    case "md": {
      return docDocIcon;
    }
    case "txt": {
      return docTxtIcon;
    }
    case "json": {
      return docJsonIcon;
    }
    case "html": {
      return docHtmlIcon;
    }
    case "csv": {
      return docCsvIcon;
    }
    case "xls":
    case "xlsx":
    case "ods": {
      return docCsvIcon;
    }
    case "ppt":
    case "pptx":
    case "odp": {
      return docDocIcon;
    }
    default: {
      return null;
    }
  }
}

function getPreviewIconSrc(preview: {
  kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
  filename: string;
}): string | null {
  if (preview.kind === "csv") {
    return docCsvIcon;
  }
  return getFileTypeIcon(preview.filename);
}

// ---------------------------------------------------------------------------
// AttachmentLightbox — full-screen attachment viewer
// ---------------------------------------------------------------------------

function filenameFromUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop();
  return last && last.length > 0 ? last : "image";
}

function getAttachmentDownloadUrl(url: string): string {
  if (!URL.canParse(url, window.location.origin)) {
    return url;
  }
  const parsed = new URL(url, window.location.origin);
  const isFileRoute = /^\/f\/[^/]+\/[^/]+\/[^/]+$/.test(parsed.pathname);
  if (isFileRoute) {
    parsed.searchParams.set("download", "1");
  }
  return parsed.toString();
}

export function getAttachmentRawUrl(url: string): string {
  if (!URL.canParse(url, window.location.origin)) {
    return url;
  }
  const parsed = new URL(url, window.location.origin);
  const isFileRoute = /^\/f\/[^/]+\/[^/]+\/[^/]+$/.test(parsed.pathname);
  if (isFileRoute) {
    parsed.searchParams.delete("download");
    parsed.searchParams.set("raw", "1");
  }
  return parsed.toString();
}

function triggerDirectDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = getAttachmentDownloadUrl(url);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function TextPreviewLoader({
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

function parseCsvRows(text: string): string[][] {
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

function triggerBlobDownload(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

// Fetch the asset as a blob, degrading to a new-tab fallback on network /
// CORS failure. The `.catch` is intentionally scoped to the fetch branch so
// only network failures fall back — any synchronous DOM / blob failure after
// a successful fetch is a real bug and propagates to the caller. The
// fallback keeps the user on the same page and lets the app's `/f/...`
// route force `Content-Disposition: attachment` via `?download=1`.
async function fetchBlobOrOpen(
  url: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  // The catch branch performs the direct-download fallback.
  // Confirmed by ethan@vm0.ai.
  // eslint-disable-next-line no-restricted-syntax -- fetch/CORS failures intentionally fall back to direct download
  try {
    const res = await fetch(getAttachmentDownloadUrl(url), {
      mode: "cors",
      signal,
    });
    if (!res.ok) {
      throw new Error(`fetch failed: ${String(res.status)}`);
    }
    return await res.blob();
  } catch (error) {
    signal.throwIfAborted();
    log.warn(
      "downloadUrl: fetch failed, falling back to direct download",
      error,
    );
    triggerDirectDownload(url, filenameFromUrl(url));
    return null;
  }
}

export async function downloadAttachmentUrl(
  url: string,
  signal: AbortSignal,
  filename = filenameFromUrl(url),
): Promise<void> {
  const blob = await fetchBlobOrOpen(url, signal);
  if (blob !== null) {
    triggerBlobDownload(blob, filename);
  }
}

function isImageLightboxZoomAtReset(zoom: number): boolean {
  return Math.abs(zoom - 1) < 0.001;
}

function ImageLightboxControls({
  closeLightbox,
  download,
  resetZoom,
  zoom,
  zoomIn,
  zoomOut,
}: {
  closeLightbox: () => void;
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

function ImageLightboxKeyboardShortcuts() {
  const keyboardShortcutsRef = useSet(imageLightboxKeyboardShortcutsRef$);

  return <span ref={keyboardShortcutsRef} hidden />;
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
  const imageState = useGet(imageLightboxState$);
  const resetZoom = useSet(resetImageLightboxZoom$);
  const setImageLightboxStatus = useSet(setImageLightboxStatus$);
  const zoomIn = useSet(zoomImageLightboxIn$);
  const zoomOut = useSet(zoomImageLightboxOut$);

  const download = () => {
    detach(
      downloadAttachmentUrl(url, pageSignal),
      Reason.DomCallback,
      "attachment download",
    );
  };

  const { imageStatus, zoom } = imageState;

  return (
    <>
      <ImageLightboxKeyboardShortcuts />
      <ImageLightboxControls
        closeLightbox={closeLightbox}
        download={download}
        resetZoom={resetZoom}
        zoom={zoom}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
      />
      <div
        className="relative flex items-center justify-center transition-transform duration-150 animate-in zoom-in-95"
        style={{ transform: `scale(${String(zoom)})` }}
      >
        {imageStatus !== "loaded" && (
          <div
            data-testid="attachment-lightbox-image-loading"
            className="flex h-[min(85vh,480px)] w-[min(90vw,720px)] items-center justify-center rounded-lg bg-black/30 text-white shadow-2xl"
          >
            {imageStatus === "loading" ? (
              <IconLoader2 size={24} stroke={1.8} className="animate-spin" />
            ) : (
              <IconPhoto size={24} stroke={1.5} />
            )}
          </div>
        )}
        <img
          key={url}
          ref={imageLightboxImageRef}
          src={url}
          alt=""
          data-testid="attachment-lightbox-image"
          onLoad={() => {
            setImageLightboxStatus("loaded");
          }}
          onError={() => {
            setImageLightboxStatus("error");
          }}
          className={`max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl ${
            imageStatus === "loaded" ? "" : "absolute inset-0 opacity-0"
          }`}
        />
      </div>
    </>
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
      className="pointer-events-auto fixed inset-0 z-[9999] isolate flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 outline-none"
      style={{ pointerEvents: "auto" }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      data-testid="attachment-lightbox"
    >
      <ImageLightboxContent
        closeLightbox={closeLightbox}
        pageSignal={pageSignal}
        url={url}
      />
    </div>,
    document.body,
  );
}

export function AttachmentLightbox() {
  const preview = useGet(lightboxUrl$);
  const dialogRef = useSet(lightboxDialogRef$);
  const closeLightbox = useSet(closeLightbox$);
  const pageSignal = useGet(pageSignal$);

  if (!preview) {
    return null;
  }

  if (preview.kind === "image") {
    return <ImageLightbox url={preview.url} />;
  }

  const iconSrc = getPreviewIconSrc(preview);

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeLightbox();
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="pointer-events-auto fixed inset-0 z-[9999] isolate flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 outline-none"
      style={{ pointerEvents: "auto" }}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      data-testid="attachment-lightbox"
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
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
      <div className="w-[min(92vw,1100px)] rounded-2xl bg-background shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="flex items-center gap-3 border-b border-foreground/10 px-4 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
            {iconSrc ? (
              <img
                alt=""
                aria-hidden="true"
                src={iconSrc}
                className="h-7 w-7 object-contain opacity-90"
              />
            ) : (
              <IconFile
                size={22}
                stroke={1.8}
                className="text-muted-foreground"
              />
            )}
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
          <iframe
            src={preview.url}
            title={`${preview.filename} preview`}
            sandbox={preview.kind === "html" ? "" : undefined}
            className="h-[min(78vh,900px)] w-full bg-background"
          />
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

        const [header, ...body] = rows;

        return (
          <div className="h-[min(78vh,900px)] overflow-auto p-6">
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
          </div>
        );
      }}
    </TextPreviewLoader>
  );
}

// ---------------------------------------------------------------------------
// FileAttachmentChip — compact chip shown inside sent message bubbles
// ---------------------------------------------------------------------------

export function FileAttachmentChip({
  filename,
  url,
}: {
  filename: string;
  url: string;
}) {
  const iconSrc = getFileTypeIcon(filename);
  return (
    <a
      href={getAttachmentDownloadUrl(url)}
      download={filename}
      title={filename}
      className="inline-flex items-center justify-center rounded-lg hover:bg-foreground/10 transition-colors p-0.5"
    >
      {iconSrc ? (
        <img
          alt=""
          className="h-9 w-9 object-contain opacity-80"
          aria-hidden="true"
          src={iconSrc}
        />
      ) : (
        <IconFile size={28} stroke={1.5} className="text-muted-foreground" />
      )}
    </a>
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
  const iconSrc = getFileTypeIcon(filename);
  const openDocumentLightbox = useSet(openDocumentLightbox$);

  return (
    <button
      type="button"
      onClick={() => {
        openDocumentLightbox({ kind, url, filename });
      }}
      title={filename}
      aria-label={`Open ${kind} preview for ${filename}`}
      className="inline-flex items-center justify-center rounded-lg hover:bg-foreground/10 transition-colors p-0.5"
    >
      {iconSrc ? (
        <img
          alt=""
          className="h-9 w-9 object-contain opacity-80"
          aria-hidden="true"
          src={iconSrc}
        />
      ) : (
        <IconFile size={28} stroke={1.5} className="text-muted-foreground" />
      )}
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
  const isVideo = attachment.contentType.startsWith("video/");
  const isAudio = attachment.contentType.startsWith("audio/");
  const iconSrc =
    isImage || isVideo || isAudio ? null : getFileTypeIcon(attachment.filename);
  return (
    <>
      <div
        className="relative inline-flex items-center justify-center"
        title={attachment.filename}
      >
        {isImage ? (
          <ComposerImagePreviewButton
            filename={attachment.filename}
            openImageLightbox={openImageLightbox}
            url={url}
          />
        ) : isVideo ? (
          <IconVideo size={28} stroke={1.5} className="text-muted-foreground" />
        ) : isAudio ? (
          <IconFileMusic
            size={28}
            stroke={1.5}
            className="text-muted-foreground"
          />
        ) : iconSrc ? (
          <img
            alt=""
            className="h-9 w-9 object-contain opacity-80"
            aria-hidden="true"
            src={iconSrc}
          />
        ) : (
          <IconFile size={28} stroke={1.5} className="text-muted-foreground" />
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
    </>
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
