import { Component, type ReactNode } from "react";
import {
  IconDownload,
  IconExternalLink,
  IconFileText,
} from "@tabler/icons-react";
import { Markdown } from "../components/markdown.tsx";

type ChatAttachmentKind =
  | "image"
  | "video"
  | "markdown"
  | "text"
  | "json"
  | "pdf"
  | "html"
  | "file";

interface ChatAttachmentDescriptor {
  filename: string;
  url: string;
  contentType?: string;
}

type TextPreviewProps = {
  filename: string;
  url: string;
  kind: "markdown" | "text" | "json";
};

type TextPreviewState = {
  status: "loading" | "loaded" | "error";
  text: string;
};

type IframePreviewProps = {
  filename: string;
  url: string;
  kind: "pdf" | "html";
};

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

  if (type === "text/markdown" || ext === "md") {
    return "markdown";
  }
  if (type === "text/plain" || ext === "txt") {
    return "text";
  }
  if (type === "application/json" || ext === "json") {
    return "json";
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

  return "file";
}

function toDownloadUrl(url: string): string {
  if (url.includes("download=1")) {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function PreviewActions({ filename, url }: { filename: string; url: string }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <a
        href={toDownloadUrl(url)}
        download={filename}
        title={filename}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <IconDownload size={14} />
        Download
      </a>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <IconExternalLink size={14} />
        Open
      </a>
    </div>
  );
}

function PreviewShell({
  filename,
  url,
  badge,
  children,
}: {
  filename: string;
  url: string;
  badge: string;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-xl border border-foreground/10 bg-background/60 p-3"
      data-testid={`attachment-preview-${badge}`}
    >
      <div className="flex items-center gap-2 pb-2">
        <IconFileText size={16} className="text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {filename}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {badge}
        </span>
      </div>
      {children}
      <PreviewActions filename={filename} url={url} />
    </div>
  );
}

class TextPreview extends Component<TextPreviewProps, TextPreviewState> {
  state = {
    status: "loading" as const,
    text: "",
  };

  #active = false;

  componentDidMount() {
    this.#active = true;
    this.#loadText();
  }

  componentDidUpdate(previousProps: Readonly<TextPreviewProps>) {
    if (previousProps.url !== this.props.url) {
      this.#loadText();
    }
  }

  componentWillUnmount() {
    this.#active = false;
  }

  #loadText() {
    this.setState({ status: "loading", text: "" });

    fetch(this.props.url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        return await response.text();
      })
      .then((text) => {
        if (this.#active) {
          this.setState({ status: "loaded", text });
        }
      })
      .catch(() => {
        if (this.#active) {
          this.setState({ status: "error", text: "" });
        }
      });
  }

  render() {
    const { filename, url, kind } = this.props;
    const { status, text } = this.state;

    let content: ReactNode = (
      <p className="text-xs text-muted-foreground">Loading preview…</p>
    );

    if (status === "error") {
      content = (
        <p className="text-xs text-muted-foreground">
          Preview unavailable. Use open or download instead.
        </p>
      );
    } else if (status === "loaded") {
      const trimmed = text.length > 8000 ? `${text.slice(0, 8000)}\n\n…` : text;
      if (kind === "markdown") {
        content = (
          <div className="max-h-72 overflow-auto pr-1">
            <Markdown source={trimmed} />
          </div>
        );
      } else {
        content = (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-xs text-foreground">
            {trimmed}
          </pre>
        );
      }
    }

    return (
      <PreviewShell filename={filename} url={url} badge={kind}>
        {content}
      </PreviewShell>
    );
  }
}

class IframePreview extends Component<
  IframePreviewProps,
  { showPreview: boolean }
> {
  state = { showPreview: false };

  render() {
    const { filename, url, kind } = this.props;

    return (
      <PreviewShell filename={filename} url={url} badge={kind}>
        {!this.state.showPreview ? (
          <button
            type="button"
            onClick={() => {
              this.setState({ showPreview: true });
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/60"
          >
            Load preview
          </button>
        ) : (
          <iframe
            src={url}
            title={`${filename} preview`}
            sandbox={kind === "html" ? "" : undefined}
            className="h-72 w-full rounded-lg border border-foreground/10 bg-background"
          />
        )}
      </PreviewShell>
    );
  }
}

export function AttachmentPreview({
  attachment,
}: {
  attachment: ChatAttachmentDescriptor;
}) {
  const kind = classifyChatAttachment(attachment);

  switch (kind) {
    case "markdown": {
      return (
        <TextPreview
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
        />
      );
    }
    case "json": {
      return (
        <TextPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="json"
        />
      );
    }
    case "pdf": {
      return (
        <IframePreview
          filename={attachment.filename}
          url={attachment.url}
          kind="pdf"
        />
      );
    }
    case "html": {
      return (
        <IframePreview
          filename={attachment.filename}
          url={attachment.url}
          kind="html"
        />
      );
    }
    default: {
      return null;
    }
  }
}
