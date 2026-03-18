import { IconFile, IconPhoto, IconLoader2, IconX } from "@tabler/icons-react";
import type { ZeroChatAttachment } from "../../signals/zero-page/zero-chat.ts";
import docPdfIcon from "./assets/doc-pdf.svg";
import docDocIcon from "./assets/doc-doc.svg";
import docCsvIcon from "./assets/doc-csv.svg";

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
    case "md":
    case "txt":
    case "json":
    case "html": {
      return docDocIcon;
    }
    case "csv": {
      return docCsvIcon;
    }
    default: {
      return null;
    }
  }
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
      href={url}
      download={filename}
      title={filename}
      className="inline-flex items-center justify-center rounded-lg hover:bg-foreground/10 transition-colors p-0.5"
    >
      {iconSrc ? (
        <img
          alt=""
          className="h-6 w-6 object-contain opacity-80"
          aria-hidden="true"
          src={iconSrc}
        />
      ) : (
        <IconFile size={20} stroke={1.5} className="text-muted-foreground" />
      )}
    </a>
  );
}

// ---------------------------------------------------------------------------
// AttachmentChip — chip shown in the composer before the message is sent
// ---------------------------------------------------------------------------

export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ZeroChatAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.contentType.startsWith("image/");
  const iconSrc = isImage ? null : getFileTypeIcon(attachment.filename);
  return (
    <div
      className="relative inline-flex items-center justify-center"
      title={attachment.filename}
    >
      {isImage ? (
        <div className="relative h-6 w-6 rounded-lg overflow-hidden border border-foreground/10">
          {attachment.url ? (
            <img
              src={attachment.url}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <IconPhoto
              size={16}
              stroke={1.5}
              className="text-muted-foreground m-auto h-full"
            />
          )}
        </div>
      ) : iconSrc ? (
        <img
          alt=""
          className="h-6 w-6 object-contain opacity-80"
          aria-hidden="true"
          src={iconSrc}
        />
      ) : (
        <IconFile size={20} stroke={1.5} className="text-muted-foreground" />
      )}
      {attachment.uploading ? (
        <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
          <IconLoader2
            size={10}
            className="animate-spin text-muted-foreground"
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors"
          aria-label={`Remove ${attachment.filename}`}
        >
          <IconX size={9} stroke={2.5} />
        </button>
      )}
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
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3">
      {attachments.map((a) => (
        <AttachmentChip
          key={a.id}
          attachment={a}
          onRemove={() => onRemove(a.id)}
        />
      ))}
    </div>
  );
}
