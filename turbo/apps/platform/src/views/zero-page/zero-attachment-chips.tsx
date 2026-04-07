import type { MouseEvent } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconFile, IconPhoto, IconLoader2, IconX } from "@tabler/icons-react";
import type { ZeroChatAttachment } from "../../signals/chat-page/chat-message.ts";
import {
  lightboxUrl$,
  setLightboxUrl$,
  lightboxDialogRef$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
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
// ImageLightbox — full-screen image viewer
// ---------------------------------------------------------------------------

export function ImageLightbox({ url }: { url: string }) {
  const dialogRef = useSet(lightboxDialogRef$);
  const closeLightbox = useSet(setLightboxUrl$);

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      closeLightbox(null);
    }
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200 outline-none"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={() => {
          return closeLightbox(null);
        }}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Close"
      >
        <IconX size={20} stroke={2} />
      </button>
      <img
        src={url}
        alt=""
        className="max-h-[85vh] max-w-[90vw] rounded-lg shadow-2xl object-contain animate-in zoom-in-95 duration-200"
      />
    </div>
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
      href={url}
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
  const lightboxUrl = useGet(lightboxUrl$);
  const setLightboxUrlFn = useSet(setLightboxUrl$);
  const isImage = attachment.contentType.startsWith("image/");
  const iconSrc = isImage ? null : getFileTypeIcon(attachment.filename);
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
              return url && setLightboxUrlFn(url);
            }}
            disabled={!url}
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
      {lightboxUrl && <ImageLightbox url={lightboxUrl} />}
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
