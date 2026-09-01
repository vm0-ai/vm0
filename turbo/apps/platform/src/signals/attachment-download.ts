import { command } from "ccstate";
import {
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "../views/okou-page/attachment-url.ts";
import { pageAttachmentResourceUrlResolver$ } from "./attachment-resource-url.ts";

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
    const resolveResourceUrl = get(pageAttachmentResourceUrlResolver$);
    const { resourceUrl } = await get(
      resolveResourceUrl(publicAttachmentUrl(attachment.url)),
    );
    signal.throwIfAborted();
    await downloadAttachmentUrl(resourceUrl, signal, attachment.filename);
  },
);
