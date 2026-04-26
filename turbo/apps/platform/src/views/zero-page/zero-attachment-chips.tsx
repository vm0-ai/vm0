import { Component, type MouseEvent, type ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { createPortal } from "react-dom";
import {
  IconDownload,
  IconFile,
  IconPhoto,
  IconVideo,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import type { ZeroChatAttachment } from "../../signals/chat-page/chat-message.ts";
import { logger } from "../../signals/log.ts";
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
const TEXT_PREVIEW_MAX_BYTES = 65_536;

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

function triggerDirectDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = getAttachmentDownloadUrl(url);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function toRawUrl(url: string): string {
  if (!URL.canParse(url, window.location.origin)) {
    const hashIndex = url.indexOf("#");
    const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
    if (base.includes("raw=1")) {
      return url;
    }
    return `${base}${base.includes("?") ? "&" : "?"}raw=1${hash}`;
  }

  const parsed = new URL(url, window.location.origin);
  if (parsed.searchParams.get("raw") !== "1") {
    parsed.searchParams.set("raw", "1");
  }
  return parsed.toString();
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let reachedLimit = false;

  while (received < TEXT_PREVIEW_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const remaining = TEXT_PREVIEW_MAX_BYTES - received;
    const chunk =
      value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (received >= TEXT_PREVIEW_MAX_BYTES) {
      reachedLimit = true;
      break;
    }
  }

  if (reachedLimit) {
    await reader.cancel();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function fetchPreviewText(url: string, signal: AbortSignal): Promise<string> {
  return fetch(toRawUrl(url), {
    headers: { Range: `bytes=0-${String(TEXT_PREVIEW_MAX_BYTES - 1)}` },
    signal,
  }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`HTTP ${String(res.status)}`);
    }
    return await readLimitedText(res);
  });
}

type TextLoadState = {
  status: "loading" | "loaded" | "error";
  text: string;
};

class TextPreviewLoader extends Component<
  {
    url: string;
    signal: AbortSignal;
    children: (state: TextLoadState) => ReactNode;
  },
  TextLoadState
> {
  state: TextLoadState = {
    status: "loading",
    text: "",
  };

  #active = false;

  componentDidMount() {
    this.#active = true;
    this.loadText();
  }

  componentDidUpdate(
    previousProps: Readonly<{ url: string; signal: AbortSignal }>,
  ) {
    if (
      previousProps.url !== this.props.url ||
      previousProps.signal !== this.props.signal
    ) {
      this.loadText();
    }
  }

  componentWillUnmount() {
    this.#active = false;
  }

  loadText() {
    this.setState({ status: "loading", text: "" });
    const { signal, url } = this.props;

    fetchPreviewText(url, signal)
      .then((text) => {
        if (this.#active && this.props.url === url && !signal.aborted) {
          this.setState({ status: "loaded", text });
        }
      })
      .catch(() => {
        if (this.#active && this.props.url === url && !signal.aborted) {
          this.setState({ status: "error", text: "" });
        }
      });
  }

  render() {
    const { status, text } = this.state;
    return this.props.children({ status, text });
  }
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
function fetchBlobOrOpen(
  url: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  return fetch(getAttachmentDownloadUrl(url), { mode: "cors", signal })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`fetch failed: ${String(res.status)}`);
      }
      return res.blob();
    })
    .catch((error: unknown) => {
      signal.throwIfAborted();
      log.warn(
        "downloadUrl: fetch failed, falling back to direct download",
        error,
      );
      triggerDirectDownload(url, filenameFromUrl(url));
      return null;
    });
}

function downloadAttachmentUrl(
  url: string,
  signal: AbortSignal,
): Promise<void> {
  const filename = filenameFromUrl(url);
  return fetchBlobOrOpen(url, signal).then((blob) => {
    if (blob !== null) {
      triggerBlobDownload(blob, filename);
    }
  });
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
      className="fixed inset-0 z-[9999] isolate flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 outline-none"
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
              downloadAttachmentUrl(url, pageSignal),
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
            return closeLightbox();
          }}
          className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          aria-label="Close"
        >
          <IconX size={20} stroke={2} />
        </button>
      </div>
      <img
        src={url}
        alt=""
        className="max-h-[85vh] max-w-[90vw] rounded-lg shadow-2xl object-contain animate-in zoom-in-95 duration-200"
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
      className="fixed inset-0 z-[9999] isolate flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 outline-none"
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
  const iconSrc =
    isImage || isVideo ? null : getFileTypeIcon(attachment.filename);
  return (
    <>
      <div
        className="relative inline-flex items-center justify-center"
        title={attachment.filename}
      >
        {isImage ? (
          <button
            type="button"
            onClick={() => {
              return url && openImageLightbox(url);
            }}
            disabled={!url}
            aria-label={`Open image preview for ${attachment.filename}`}
            title={attachment.filename}
            className="group relative h-9 w-9 rounded-lg overflow-hidden border border-foreground/10 hover:border-foreground/25 transition-colors"
          >
            {url ? (
              <>
                <img src={url} alt="" className="h-full w-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
                  <IconPhoto
                    size={18}
                    className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow"
                  />
                </span>
              </>
            ) : (
              <IconPhoto
                size={20}
                stroke={1.5}
                className="text-muted-foreground m-auto h-full"
              />
            )}
          </button>
        ) : isVideo ? (
          <IconVideo size={28} stroke={1.5} className="text-muted-foreground" />
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
