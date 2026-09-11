import { command } from "ccstate";
import { downloadAttachmentUrl } from "../views/okou-page/attachment-url.ts";
import { classifyChatAttachment } from "./chat-page/parse-body-blocks.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";

type AttachmentDownload = {
  readonly filename: string;
  readonly url: string;
};

/**
 * Resolve private uploaded files through the authenticated signing endpoint
 * before fetching their bytes. Public artifact URLs pass through unchanged.
 */
export const downloadAttachment$ = command(
  async (
    { get },
    attachment: AttachmentDownload,
    signal: AbortSignal,
  ): Promise<void> => {
    const preview = createAttachmentPreviewSignals(attachment.url);
    const [resourceUrl, shareUrl] = await Promise.all([
      get(preview.resourceUrl$),
      get(preview.shareUrl$),
    ]);
    signal.throwIfAborted();
    await downloadAttachmentUrl(
      resourceUrl,
      signal,
      attachment.filename,
      classifyChatAttachment({
        filename: attachment.filename,
        url: resourceUrl,
      }) === "file"
        ? "native"
        : "blob",
      shareUrl === null ? "default" : "reload",
    );
  },
);
