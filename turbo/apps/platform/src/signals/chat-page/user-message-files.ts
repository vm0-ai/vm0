import type {
  ResolvedAttachFile,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

export function canonicalUserMessageFileUrl(fileId: string): string {
  return `/api/zero/web/download-file?file_id=${encodeURIComponent(fileId)}`;
}

/** Resolve the file parts without consulting legacy chat-event projections. */
export function userMessageFileAttachments(
  document: UserMessageDocument | undefined,
): ResolvedAttachFile[] {
  return (document?.parts ?? []).flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    return [
      {
        id: part.fileId,
        filename: part.filenameSnapshot,
        contentType: part.contentType,
        size: 0,
        url: canonicalUserMessageFileUrl(part.fileId),
      },
    ];
  });
}
