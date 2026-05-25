import type { MouseEvent, ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { createPortal } from "react-dom";
import {
  IconDownload,
  IconLink,
  IconPhoto,
  IconLoader2,
  IconZoomIn,
  IconZoomOut,
  IconZoomReset,
  IconX,
} from "@tabler/icons-react";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { ZeroChatAttachment } from "../../signals/chat-page/chat-message.ts";
import { logger } from "../../signals/log.ts";
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";
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
import { FilePreviewIcon } from "./zero-file-preview-icon.tsx";

const log = logger("zero-attachment-chips");

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

function filenameFromUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop();
  return last && last.length > 0 ? last : "image";
}

const LEGACY_FILE_PATH_PATTERN = /^\/f\/([^/]+)\/([^/]+)\/([^/]+)$/;
const ARTIFACT_FILE_PATH_PATTERN = /^\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/;
const CLERK_USER_ID_PREFIX = "user_";

function publicArtifactsBaseUrl(): string | null {
  const baseUrl = import.meta.env.PUBLIC_ARTIFACTS_BASE_URL;
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return null;
  }
  return baseUrl.replace(/\/+$/, "");
}

function hasExplicitUrlOrigin(url: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(url);
}

function browserOrigin(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.location.origin;
}

type PlatformHostTarget = "api" | "www";

function rewritePlatformHostname(
  hostname: string,
  target: PlatformHostTarget,
): string {
  return hostname.replace(/(^|-)(platform|app|www|api)\./, `$1${target}.`);
}

function addOrigin(origins: Set<string>, baseUrl: string | null) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }
  origins.add(new URL(baseUrl).origin);
}

function addPlatformOriginVariants(
  origins: Set<string>,
  baseUrl: string | null,
) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }

  const parsed = new URL(baseUrl);
  origins.add(parsed.origin);

  for (const target of ["api", "www"] as const) {
    const variant = new URL(parsed);
    variant.hostname = rewritePlatformHostname(variant.hostname, target);
    origins.add(variant.origin);
  }
}

function platformFileOrigins(): Set<string> {
  const origins = new Set<string>();
  const configuredApiUrl = import.meta.env.VITE_API_URL as string | undefined;

  addPlatformOriginVariants(origins, browserOrigin());
  addPlatformOriginVariants(origins, configuredApiUrl ?? null);
  addOrigin(origins, publicArtifactsBaseUrl());

  return origins;
}

function isPlatformFileUrlHost(parsed: URL, sourceUrl: string): boolean {
  return (
    !hasExplicitUrlOrigin(sourceUrl) || platformFileOrigins().has(parsed.origin)
  );
}

function storageUserIdSegmentFromFileUrlSegment(userIdSegment: string): string {
  if (
    userIdSegment === "user" ||
    userIdSegment.startsWith(CLERK_USER_ID_PREFIX) ||
    userIdSegment.startsWith("user-")
  ) {
    return userIdSegment;
  }
  return `${CLERK_USER_ID_PREFIX}${userIdSegment}`;
}

function artifactCdnUrl(args: {
  userIdSegment: string;
  idSegment: string;
  filenameSegment: string;
  hash: string;
}): string | null {
  const baseUrl = publicArtifactsBaseUrl();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/artifacts/${args.userIdSegment}/${args.idSegment}/${args.filenameSegment}${args.hash}`;
}

function parseFileUrl(url: string): URL | null {
  const baseUrl = browserOrigin() ?? undefined;
  if (!URL.canParse(url, baseUrl)) {
    return null;
  }
  return new URL(url, baseUrl);
}

function normalizedLegacyFileUrl(url: string): string | null {
  const parsed = parseFileUrl(url);
  if (!parsed) {
    return null;
  }
  if (!isPlatformFileUrlHost(parsed, url)) {
    return null;
  }
  const match = parsed.pathname.match(LEGACY_FILE_PATH_PATTERN);
  if (!match) {
    return null;
  }
  const [, userIdSegment, idSegment, filenameSegment] = match;
  return artifactCdnUrl({
    userIdSegment: storageUserIdSegmentFromFileUrlSegment(userIdSegment),
    idSegment,
    filenameSegment,
    hash: parsed.hash,
  });
}

function normalizedArtifactFileUrl(url: string): string | null {
  const parsed = parseFileUrl(url);
  if (!parsed) {
    return null;
  }
  if (!isPlatformFileUrlHost(parsed, url)) {
    return null;
  }
  const match = parsed.pathname.match(ARTIFACT_FILE_PATH_PATTERN);
  if (!match) {
    return null;
  }
  const [, userIdSegment, idSegment, filenameSegment] = match;
  return artifactCdnUrl({
    userIdSegment,
    idSegment,
    filenameSegment,
    hash: parsed.hash,
  });
}

export function publicAttachmentUrl(url: string): string {
  return normalizedLegacyFileUrl(url) ?? normalizedArtifactFileUrl(url) ?? url;
}

export function getAttachmentRawUrl(url: string): string {
  return url;
}

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

// Fetch the asset as a blob so downloads are delivered from a same-origin
// object URL. Cross-origin `<a download>` is intentionally avoided because
// browsers ignore it for CDN image URLs and open the asset instead.
async function fetchBlobForDownload(
  url: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  const fetchUrl = publicAttachmentUrl(url);
  // The catch branch reports network/CORS failures without falling back to
  // cross-origin anchor navigation, which would open images instead.
  // eslint-disable-next-line no-restricted-syntax -- fetch/CORS failures should surface as download failures
  try {
    const res = await fetch(fetchUrl, {
      cache: "reload",
      mode: "cors",
      signal,
    });
    if (!res.ok) {
      throw new Error(`fetch failed: ${String(res.status)}`);
    }
    return await res.blob();
  } catch (error) {
    signal.throwIfAborted();
    log.warn("downloadUrl: fetch failed", error);
    toast.error("Download failed");
    return null;
  }
}

export async function downloadAttachmentUrl(
  url: string,
  signal: AbortSignal = AbortSignal.any([]),
  filename = filenameFromUrl(url),
): Promise<void> {
  const blob = await fetchBlobForDownload(url, signal);
  if (blob !== null) {
    triggerBlobDownload(blob, filename);
  }
}

async function copyAttachmentLinkToClipboard(url: string): Promise<void> {
  const copied = await writeToClipboard(publicAttachmentUrl(url));
  if (copied) {
    toast.success("Link copied");
    return;
  }
  toast.error("Failed to copy link");
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
        aria-label="Copy link"
      >
        <IconLink size={20} stroke={2} />
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
  const copyLink = () => {
    detach(
      copyAttachmentLinkToClipboard(url),
      Reason.DomCallback,
      "attachment copy link",
    );
  };

  const { imageStatus, zoom } = imageState;

  return (
    <>
      <ImageLightboxKeyboardShortcuts />
      <ImageLightboxControls
        closeLightbox={closeLightbox}
        copyLink={copyLink}
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
      className="pointer-events-auto fixed inset-0 z-[9999] isolate flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 outline-none"
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
          aria-label="Copy link"
        >
          <IconLink size={20} stroke={2} />
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
      <div className="relative z-10 flex w-[min(92vw,1100px)] min-w-0 overflow-hidden rounded-2xl bg-black shadow-2xl animate-in zoom-in-95 duration-200">
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

  if (preview.kind === "video") {
    return <VideoLightbox filename={preview.filename} url={preview.url} />;
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
      className="pointer-events-auto fixed inset-0 z-[9999] isolate flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 outline-none"
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
          aria-label="Copy link"
        >
          <IconLink size={20} stroke={2} />
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
      <div className="relative z-10 w-[min(92vw,1100px)] min-w-0 rounded-2xl bg-background shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
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
