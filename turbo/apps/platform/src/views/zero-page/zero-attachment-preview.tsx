import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconDownload,
  IconEye,
  IconExternalLink,
  IconFileMusic,
  IconFileTypePdf,
  IconLoader2,
  IconPlayerPlay,
  IconTable,
  IconVideo,
  IconWorld,
} from "@tabler/icons-react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import type { Computed } from "ccstate";
import { detach, jsonParseOr, Reason } from "../../signals/utils.ts";
import {
  textPreviewCollapsedByKey$,
  toggleTextPreviewCollapsed$,
} from "../../signals/view-component-state.ts";
import { lightboxUrl$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  chatArtifactSidebarEnabled$,
  openDocumentLightboxOrArtifact$,
  openVideoLightboxOrArtifact$,
} from "../../signals/zero-page/zero-artifact-sidebar.ts";
import {
  classifyChatAttachment,
  EMPTY_TEXT$,
} from "../../signals/chat-page/parse-body-blocks.ts";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "./zero-file-preview-icon.tsx";
import {
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "./zero-attachment-chips.tsx";

interface ChatAttachmentDescriptor {
  filename: string;
  url: string;
  contentType?: string;
}

type DocumentPreviewKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html";

function contentTypeForDocumentPreviewKind(kind: DocumentPreviewKind): string {
  if (kind === "markdown") {
    return "text/markdown";
  }
  if (kind === "text") {
    return "text/plain";
  }
  if (kind === "json") {
    return "application/json";
  }
  if (kind === "csv") {
    return "text/csv";
  }
  if (kind === "pdf") {
    return "application/pdf";
  }
  return "text/html";
}

function normalizePlatformFileUrl(url: string): string {
  return url;
}

function formatPreviewText(kind: "text" | "json", text: string): string {
  if (kind === "json") {
    const parsed = jsonParseOr<unknown>(text, null);
    return parsed === null ? text : JSON.stringify(parsed, null, 2);
  }
  return text;
}

function shouldUseNativeAnchorNavigation(
  event: ReactMouseEvent<HTMLAnchorElement>,
): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

type TextPreviewProps = {
  filename: string;
  url: string;
  kind: "text" | "json";
  text$?: Computed<Promise<string>>;
};

function TextPreview(props: TextPreviewProps) {
  const sidebarEnabled = useGet(chatArtifactSidebarEnabled$);
  if (sidebarEnabled) {
    return (
      <AttachmentAnchorChip
        filename={props.filename}
        url={props.url}
        kind={props.kind}
      />
    );
  }
  return <TextPreviewInline {...props} />;
}

type AttachmentAnchorChipKind =
  | "text"
  | "json"
  | "markdown"
  | "csv"
  | "pdf"
  | "html";

function attachmentAnchorChipIcon(kind: AttachmentAnchorChipKind): ReactNode {
  if (kind === "html") {
    return <IconWorld size={13} stroke={1.8} />;
  }
  if (kind === "csv") {
    return <IconTable size={13} stroke={1.8} />;
  }
  if (kind === "pdf") {
    return <IconFileTypePdf size={13} stroke={1.8} />;
  }
  return <IconExternalLink size={13} stroke={1.8} />;
}

function AttachmentAnchorChip({
  filename,
  url,
  kind,
}: {
  filename: string;
  url: string;
  kind: AttachmentAnchorChipKind;
}) {
  const publicUrl = publicAttachmentUrl(url);
  // Switch-aware open. html chips can render even when the sidebar feature is
  // off, in which case this routes back to the legacy modal lightbox.
  const openDocument = useSet(openDocumentLightboxOrArtifact$);

  return (
    <a
      href={publicUrl}
      data-testid={`attachment-preview-${kind}`}
      onClick={(event) => {
        if (shouldUseNativeAnchorNavigation(event)) {
          return;
        }
        event.preventDefault();
        event.currentTarget.blur();
        openDocument({ kind, url, filename });
      }}
      aria-label={`Open ${kind} preview for ${filename}`}
      title={filename}
      className="group/anchor-chip inline-flex min-h-8 max-w-[min(100%,520px)] w-fit items-center gap-2 self-start rounded-full border border-foreground/10 bg-background px-2 py-1 pr-3 text-left align-top text-sm text-foreground no-underline transition-colors hover:border-foreground/20 hover:bg-muted/40"
    >
      <span
        data-testid={`attachment-preview-${kind}-icon`}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-muted/40 text-muted-foreground transition-colors group-hover/anchor-chip:border-foreground/15 group-hover/anchor-chip:bg-muted/60 group-hover/anchor-chip:text-foreground"
      >
        {attachmentAnchorChipIcon(kind)}
      </span>
      <span className="min-w-0 truncate font-medium">{filename}</span>
    </a>
  );
}

function TextPreviewInline({ filename, url, kind, text$ }: TextPreviewProps) {
  const textPreviewCollapsedByKey = useGet(textPreviewCollapsedByKey$);
  const toggleTextPreviewCollapsed = useSet(toggleTextPreviewCollapsed$);
  const collapsedKey = `attachment-preview:${kind}:${filename}:${url}`;
  const text = useLastResolved(text$ ?? EMPTY_TEXT$);
  const collapsed = textPreviewCollapsedByKey[collapsedKey] ?? false;

  let content: ReactNode = (
    <div className="mt-3 flex items-center justify-center rounded-lg bg-muted/30 p-3 text-muted-foreground">
      <IconLoader2 size={16} className="animate-spin" />
    </div>
  );

  if (text !== undefined) {
    const formatted = formatPreviewText(kind, text);
    const trimmed =
      formatted.length > 8000 ? `${formatted.slice(0, 8000)}\n\n…` : formatted;
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
      <button
        type="button"
        onClick={() => {
          detach(
            downloadAttachmentUrl(
              normalizePlatformFileUrl(url),
              undefined,
              filename,
            ),
            Reason.DomCallback,
            "attachment download",
          );
        }}
        title={filename}
        aria-label={`Download ${filename}`}
        className="absolute top-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground"
      >
        <IconDownload size={12} />
      </button>
      <button
        type="button"
        onClick={() => {
          toggleTextPreviewCollapsed(collapsedKey);
        }}
        className="flex w-full items-center gap-3 text-left"
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${kind} preview for ${filename}`}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
          <FilePreviewIcon
            filename={filename}
            contentType={contentTypeForDocumentPreviewKind(kind)}
            testId={`attachment-preview-${kind}-icon`}
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

function DocumentThumbnailPreview({
  filename,
  url,
  kind,
}: {
  filename: string;
  url: string;
  kind: "markdown" | "csv" | "pdf" | "html";
}) {
  const sidebarEnabled = useGet(chatArtifactSidebarEnabled$);
  const openDocumentLightbox = useSet(openDocumentLightboxOrArtifact$);
  const lightboxOpen = useGet(lightboxUrl$) !== null;

  // html chip is always the collapsed anchor form (it has no body to inline);
  // markdown/csv/pdf use the same chip when the artifact sidebar is on, and
  // keep the full thumbnail card otherwise so legacy lightbox layouts still
  // look right.
  if (kind === "html" || sidebarEnabled) {
    return <AttachmentAnchorChip filename={filename} url={url} kind={kind} />;
  }

  const accentClass =
    kind === "markdown"
      ? "from-emerald-500/15 via-lime-500/10 to-background"
      : kind === "csv"
        ? "from-teal-500/15 via-emerald-500/10 to-background"
        : "from-rose-500/15 via-orange-500/10 to-background";

  return (
    <button
      type="button"
      data-testid={`attachment-preview-${kind}`}
      onClick={(event) => {
        event.currentTarget.blur();
        openDocumentLightbox({ kind, url, filename });
      }}
      disabled={lightboxOpen}
      className={`${lightboxOpen ? "" : "group/doc-preview"} inline-flex w-fit self-start align-top text-left disabled:pointer-events-none`}
      aria-label={`Open ${kind} preview for ${filename}`}
      title={filename}
    >
      <div
        className={`relative flex aspect-[4/3] w-[144px] items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br sm:w-[168px] ${accentClass}`}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.45),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
        <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/10 to-transparent" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-foreground/10 bg-background/90 shadow-sm transition-transform duration-200 group-hover/doc-preview:scale-105">
          <FilePreviewIcon
            filename={filename}
            contentType={contentTypeForDocumentPreviewKind(kind)}
            testId={`attachment-preview-${kind}-icon`}
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

function FileThumbnailPreview({
  filename,
  url,
  contentType,
}: {
  filename: string;
  url: string;
  contentType?: string;
}) {
  const accentClass = getFilePreviewAccentClass(filename, contentType);

  return (
    <button
      type="button"
      onClick={() => {
        detach(
          downloadAttachmentUrl(
            normalizePlatformFileUrl(url),
            undefined,
            filename,
          ),
          Reason.DomCallback,
          "attachment download",
        );
      }}
      title={filename}
      data-testid="attachment-preview-file"
      aria-label={`Download ${filename}`}
      className="group/doc-preview inline-flex w-fit self-start align-top text-left"
    >
      <div
        className={`relative flex aspect-[4/3] w-[144px] items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br sm:w-[168px] ${accentClass}`}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.45),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
        <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/10 to-transparent" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-foreground/10 bg-background/90 shadow-sm transition-transform duration-200 group-hover/doc-preview:scale-105">
          <FilePreviewIcon
            filename={filename}
            contentType={contentType}
            testId="attachment-preview-file-icon"
          />
        </div>
        <div className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/doc-preview:opacity-100">
          <IconDownload size={10} />
          Download
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
        <button
          type="button"
          onClick={() => {
            detach(
              downloadAttachmentUrl(
                normalizePlatformFileUrl(url),
                undefined,
                filename,
              ),
              Reason.DomCallback,
              "attachment download",
            );
          }}
          title={filename}
          aria-label={`Download ${filename}`}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground"
        >
          <IconDownload size={12} />
        </button>
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

function VideoThumbnailPreview({
  contentType,
  filename,
  url,
}: {
  contentType?: string;
  filename: string;
  url: string;
}) {
  const openVideoLightbox = useSet(openVideoLightboxOrArtifact$);
  const lightboxOpen = useGet(lightboxUrl$) !== null;
  const videoUrl = publicAttachmentUrl(url);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.blur();
        openVideoLightbox({ url, filename });
      }}
      disabled={lightboxOpen}
      title={filename}
      aria-label={`Open video preview for ${filename}`}
      data-testid="attachment-preview-video"
      className={`${lightboxOpen ? "" : "group/video-preview"} inline-flex w-fit self-start align-top text-left disabled:pointer-events-none`}
    >
      <div className="relative flex aspect-[4/3] w-[144px] items-center justify-center overflow-hidden rounded-xl border border-foreground/10 bg-black sm:w-[168px]">
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-stone-900 text-white">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-white/10">
            <FilePreviewIcon
              filename={filename}
              contentType={contentType ?? "video/mp4"}
              testId="attachment-preview-video-icon"
            />
          </span>
        </div>
        <video
          src={videoUrl}
          preload="metadata"
          muted
          playsInline
          aria-hidden="true"
          className="relative z-10 block h-full w-full bg-transparent object-cover opacity-90"
        />
        <div className="absolute inset-0 z-20 bg-black/15 transition-colors group-hover/video-preview:bg-black/35" />
        <span className="absolute inset-0 z-30 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition-transform group-hover/video-preview:scale-105">
            <IconPlayerPlay size={20} stroke={1.8} />
          </span>
        </span>
        <div className="absolute right-2 top-2 z-30 inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity duration-200 group-hover/video-preview:opacity-100">
          <IconVideo size={10} />
          Preview
        </div>
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-end justify-between gap-2 bg-gradient-to-t from-black/65 via-black/20 to-transparent px-2.5 py-2.5 text-white opacity-0 transition-opacity duration-200 group-hover/video-preview:opacity-100">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{filename}</div>
          </div>
        </div>
      </div>
    </button>
  );
}

export function AttachmentPreview({
  attachment,
  text$,
}: {
  attachment: ChatAttachmentDescriptor;
  text$?: Computed<Promise<string>>;
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
          url={attachment.url}
          kind="text"
          text$={text$}
        />
      );
    }
    case "json": {
      return (
        <TextPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="json"
          text$={text$}
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
    case "video": {
      return (
        <VideoThumbnailPreview
          contentType={attachment.contentType}
          filename={attachment.filename}
          url={attachment.url}
        />
      );
    }
    case "file": {
      return (
        <FileThumbnailPreview
          filename={attachment.filename}
          url={attachment.url}
          contentType={attachment.contentType}
        />
      );
    }
    default: {
      return null;
    }
  }
}
