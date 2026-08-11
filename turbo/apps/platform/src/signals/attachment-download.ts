import { command } from "ccstate";
import { downloadAttachmentUrl } from "../views/zero-page/zero-attachment-url.ts";
import { attachmentResourceUrlResolver$ } from "./attachment-resource-url.ts";

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
    const resolveResourceUrl = get(attachmentResourceUrlResolver$);
    await downloadAttachmentUrl(
      attachment.url,
      signal,
      attachment.filename,
      (url) => {
        return get(resolveResourceUrl(url));
      },
    );
  },
);
