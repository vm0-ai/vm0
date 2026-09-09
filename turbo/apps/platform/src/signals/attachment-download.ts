import { command } from "ccstate";
import {
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "../views/okou-page/attachment-url.ts";
import { classifyChatAttachment } from "./chat-page/parse-body-blocks.ts";
import { createAttachmentResourceUrl$ } from "./attachment-resource-url.ts";

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
    const { resourceUrl, shareUrl } = await get(
      createAttachmentResourceUrl$(publicAttachmentUrl(attachment.url)),
    );
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
