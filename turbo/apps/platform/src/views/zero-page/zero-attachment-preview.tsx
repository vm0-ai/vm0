import { Component, type ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconDownload,
  IconEye,
  IconFileMusic,
  IconLoader2,
} from "@tabler/icons-react";
import { useSet } from "ccstate-react";
import { jsonParseOr } from "../../signals/utils.ts";
import { openDocumentLightbox$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import docPdfIcon from "./assets/doc-pdf.svg";
import docDocIcon from "./assets/doc-doc.svg";
import docCsvIcon from "./assets/doc-csv.svg";
import docTxtIcon from "./assets/doc-txt.svg";
import docJsonIcon from "./assets/doc-json.svg";
import docHtmlIcon from "./assets/doc-html.svg";

type ChatAttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html"
  | "file";

interface ChatAttachmentDescriptor {
  filename: string;
  url: string;
  contentType?: string;
}

const TEXT_PREVIEW_MAX_BYTES = 65_536;

function fileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeType(contentType?: string): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase();
}

export function classifyChatAttachment(
  attachment: ChatAttachmentDescriptor,
): ChatAttachmentKind {
  const type = normalizeType(attachment.contentType);
  const ext = fileExt(attachment.filename);

  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }

  if (type === "text/markdown" || ext === "md") {
    return "markdown";
  }
  if (type === "text/plain" || ext === "txt") {
    return "text";
  }
  if (type === "application/json" || ext === "json") {
    return "json";
  }
  if (type === "text/csv" || ext === "csv") {
    return "csv";
  }
  if (type === "application/pdf" || ext === "pdf") {
    return "pdf";
  }
  if (type === "text/html" || ext === "html" || ext === "htm") {
    return "html";
  }

  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)
  ) {
    return "image";
  }
  if (["mp4", "webm", "mov", "ogv"].includes(ext)) {
    return "video";
  }
  if (
    ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "mpga"].includes(
      ext,
    )
  ) {
    return "audio";
  }

  return "file";
}

function getPreviewIconSrc(
  kind: "markdown" | "text" | "json" | "csv" | "pdf" | "html",
): string {
  if (kind === "pdf") {
    return docPdfIcon;
  }
  if (kind === "csv") {
    return docCsvIcon;
  }
  if (kind === "text") {
    return docTxtIcon;
  }
  if (kind === "json") {
    return docJsonIcon;
  }
  if (kind === "html") {
    return docHtmlIcon;
  }
  return docDocIcon;
}

export function filenameFromUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop();
  if (!last || last.length === 0) {
    return "file";
  }
  return last;
}

function normalizePlatformFileUrl(url: string): string {
  return url;
}

function appendSearchParam(url: string, key: string, value: string): string {
  const normalizedUrl = normalizePlatformFileUrl(url);
  if (!URL.canParse(normalizedUrl, window.location.origin)) {
    const hashIndex = normalizedUrl.indexOf("#");
    const base =
      hashIndex === -1 ? normalizedUrl : normalizedUrl.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : normalizedUrl.slice(hashIndex);
    if (base.includes(`${key}=${value}`)) {
      return normalizedUrl;
    }
    return `${base}${base.includes("?") ? "&" : "?"}${key}=${value}${hash}`;
  }

  const parsed = new URL(normalizedUrl, window.location.origin);
  if (parsed.searchParams.get(key) !== value) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function toDownloadUrl(url: string): string {
  return appendSearchParam(url, "download", "1");
}

function toRawUrl(url: string): string {
  return appendSearchParam(url, "raw", "1");
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
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    return await readLimitedText(response);
  });
}

function formatPreviewText(kind: "text" | "json", text: string): string {
  if (kind === "json") {
    const parsed = jsonParseOr<unknown>(text, null);
    return parsed === null ? text : JSON.stringify(parsed, null, 2);
  }
  return text;
}

type TextPreviewProps = {
  filename: string;
  signal: AbortSignal;
  url: string;
  kind: "text" | "json";
};

type TextPreviewState = {
  collapsed: boolean;
  status: "loading" | "loaded" | "error";
  text: string;
};

class TextPreview extends Component<TextPreviewProps, TextPreviewState> {
  state: TextPreviewState = {
    collapsed: false,
    status: "loading",
    text: "",
  };

  #active = false;

  componentDidMount() {
    this.#active = true;
    this.#loadText();
  }

  componentDidUpdate(previousProps: Readonly<TextPreviewProps>) {
    if (
      previousProps.url !== this.props.url ||
      previousProps.signal !== this.props.signal
    ) {
      this.#loadText();
    }
  }

  componentWillUnmount() {
    this.#active = false;
  }

  #loadText() {
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
    const { filename, url, kind } = this.props;
    const { collapsed, status, text } = this.state;
    const iconSrc = getPreviewIconSrc(kind);

    let content: ReactNode = (
      <div className="mt-3 flex items-center justify-center rounded-lg bg-muted/30 p-3 text-muted-foreground">
        <IconLoader2 size={16} className="animate-spin" />
      </div>
    );

    if (status === "error") {
      content = (
        <p className="text-xs text-muted-foreground">Preview unavailable.</p>
      );
    } else if (status === "loaded") {
      const formatted = formatPreviewText(kind, text);
      const trimmed =
        formatted.length > 8000
          ? `${formatted.slice(0, 8000)}\n\n…`
          : formatted;
      content = collapsed ? null : (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-xs text-foreground">
          {trimmed}
        </pre>
      );
    }

    return (
      <div
        className="relative rounded-xl border border-foreground/10 bg-background/60 p-3"
        data-testid={`attachment-preview-${kind}`}
      >
        <a
          href={toDownloadUrl(url)}
          download={filename}
          title={filename}
          aria-label={`Download ${filename}`}
          className="absolute top-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground"
        >
          <IconDownload size={12} />
        </a>
        <button
          type="button"
          onClick={() => {
            this.setState((previousState) => {
              return { collapsed: !previousState.collapsed };
            });
          }}
          className="flex w-full items-center gap-3 text-left"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${kind} preview for ${filename}`}
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
            <img
              alt=""
              aria-hidden="true"
              src={iconSrc}
              className="h-7 w-7 object-contain opacity-90"
            />
          </div>
          <div className="min-w-0 flex-1 pr-16">
            <div className="truncate text-sm font-medium text-foreground">
              {filename}
            </div>
          </div>
          <div className="shrink-0 text-muted-foreground">
            {collapsed ? (
              <IconChevronDown size={16} />
            ) : (
              <IconChevronUp size={16} />
            )}
          </div>
        </button>
        {content}
      </div>
    );
  }
}

function DocumentThumbnailPreview({
  filename,
  url,
  kind,
}: {
  filename: string;
  url: string;
  kind: "markdown" | "csv" | "pdf" | "html";
}) {
  const openDocumentLightbox = useSet(openDocumentLightbox$);
  const iconSrc = getPreviewIconSrc(kind);
  const accentClass =
    kind === "markdown"
      ? "from-emerald-500/15 via-lime-500/10 to-background"
      : kind === "csv"
        ? "from-teal-500/15 via-emerald-500/10 to-background"
        : kind === "html"
          ? "from-sky-500/15 via-cyan-500/10 to-background"
          : "from-rose-500/15 via-orange-500/10 to-background";

  return (
    <button
      type="button"
      data-testid={`attachment-preview-${kind}`}
      onClick={() => {
        openDocumentLightbox({ kind, url, filename });
      }}
      className="group/doc-preview inline-flex w-fit self-start align-top text-left"
      aria-label={`Open ${kind} preview for ${filename}`}
      title={filename}
    >
      <div
        className={`relative flex aspect-[4/3] w-[144px] items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br sm:w-[168px] ${accentClass}`}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.45),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
        <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/10 to-transparent" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-foreground/10 bg-background/90 shadow-sm transition-transform duration-200 group-hover/doc-preview:scale-105">
          <img
            alt=""
            aria-hidden="true"
            src={iconSrc}
            className="h-10 w-10 object-contain opacity-95"
          />
        </div>
        <div className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/doc-preview:opacity-100">
          <IconEye size={10} />
          Preview
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/55 via-black/15 to-transparent px-2.5 py-2.5 text-white opacity-0 transition-opacity duration-200 group-hover/doc-preview:opacity-100">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{filename}</div>
          </div>
        </div>
      </div>
    </button>
  );
}

function AudioPreview({ filename, url }: { filename: string; url: string }) {
  return (
    <div
      className="w-full max-w-md rounded-xl border border-foreground/10 bg-background/60 p-3"
      data-testid="attachment-preview-audio"
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
          <IconFileMusic size={22} stroke={1.6} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {filename}
          </div>
        </div>
        <a
          href={toDownloadUrl(url)}
          download={filename}
          title={filename}
          aria-label={`Download ${filename}`}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground"
        >
          <IconDownload size={12} />
        </a>
      </div>
      <audio
        src={url}
        controls
        preload="metadata"
        className="block w-full"
        aria-label={`Audio preview for ${filename}`}
      />
    </div>
  );
}

export function AttachmentPreview({
  attachment,
  signal,
}: {
  attachment: ChatAttachmentDescriptor;
  signal: AbortSignal;
}) {
  const kind = classifyChatAttachment(attachment);

  switch (kind) {
    case "markdown": {
      return (
        <DocumentThumbnailPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="markdown"
        />
      );
    }
    case "text": {
      return (
        <TextPreview
          filename={attachment.filename}
          signal={signal}
          url={attachment.url}
          kind="text"
        />
      );
    }
    case "json": {
      return (
        <TextPreview
          filename={attachment.filename}
          signal={signal}
          url={attachment.url}
          kind="json"
        />
      );
    }
    case "csv": {
      return (
        <DocumentThumbnailPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="csv"
        />
      );
    }
    case "pdf": {
      return (
        <DocumentThumbnailPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="pdf"
        />
      );
    }
    case "html": {
      return (
        <DocumentThumbnailPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="html"
        />
      );
    }
    case "audio": {
      return (
        <AudioPreview filename={attachment.filename} url={attachment.url} />
      );
    }
    default: {
      return null;
    }
  }
}
