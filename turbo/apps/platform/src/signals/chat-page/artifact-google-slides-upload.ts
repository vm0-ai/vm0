import { command } from "ccstate";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface GoogleSlidesUploadResult {
  readonly id: string;
  readonly name: string;
  readonly webViewLink: string | null;
}

/**
 * Upload a client-generated presentation PPTX blob to the backend, which
 * forwards it to the user's Google Drive as a native Google Slides deck. The
 * blob is generated in the view (browser-only DOM work) and passed in here so
 * this command stays a pure HTTP call.
 */
export const uploadPresentationToGoogleSlides$ = command(
  async (
    { get },
    params: {
      readonly threadId: string;
      readonly filename: string;
      readonly blob: Blob;
    },
    signal: AbortSignal,
  ): Promise<GoogleSlidesUploadResult> => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([params.blob], params.filename, { type: PPTX_MIME_TYPE }),
    );
    const client = get(zeroClient$)(chatThreadArtifactsContract);
    const result = await accept(
      client.uploadGoogleSlides({
        params: { threadId: params.threadId },
        body: formData,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);
