import { command } from "ccstate";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
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
 * Upload a client-generated presentation PPTX blob directly to artifact
 * storage, then ask the backend to forward the staged file to the user's
 * Google Drive as a native Google Slides deck. The blob is generated in the
 * view (browser-only DOM work) and passed in here so this command stays a pure
 * HTTP flow.
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
    const createClient = get(zeroClient$);
    const prepared = await accept(
      createClient(zeroUploadsContract).prepare({
        body: {
          filename: params.filename,
          contentType: PPTX_MIME_TYPE,
          size: params.blob.size,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    const uploaded = await fetch(prepared.body.uploadUrl, {
      method: "PUT",
      body: params.blob,
      headers: { "content-type": prepared.body.contentType },
      signal,
    });
    signal.throwIfAborted();
    if (!uploaded.ok) {
      throw new Error(
        `artifact storage returned ${String(uploaded.status)} ${uploaded.statusText}`,
      );
    }

    const client = createClient(chatThreadArtifactsContract);
    const stagedFormData = new FormData();
    stagedFormData.append("uploadId", prepared.body.id);
    const result = await accept(
      client.uploadGoogleSlides({
        params: { threadId: params.threadId },
        body: stagedFormData,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);
