import { command } from "ccstate";
import type {
  AttachFile,
  ChatPromptEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { getModelImageInputSupport } from "@vm0/api-contracts/contracts/model-providers";
import {
  ZERO_RECOGNITION_MAX_FILE_BYTES,
  zeroRecognitionImageMimeTypeSchema,
} from "@vm0/api-contracts/contracts/zero-recognition";
import type {
  DraftSignals,
  ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";
import { i18n } from "../../i18n/index.ts";

/**
 * Placeholder stored as the prompt when the user sends only files with no
 * typed text, so the `chatEventsContract.send` body passes its `min(1)`
 * validation. The UI strips this placeholder from `PagedUserMessage` so the
 * bubble shows only the download chips.
 */
const ATTACH_ONLY_PLACEHOLDER = "(see attached files)";

/**
 * Prepared send-message payload derived from a draft.
 *
 * - `prompt` — clean text (or `ATTACH_ONLY_PLACEHOLDER` for file-only sends).
 * - `attachFiles` — structured `AttachFile[]` for the outbound request body.
 * - `attachments` — optimistic-UI shape including resolved URLs, matching the
 *   server's paged response so the optimistic row looks identical to a refetch.
 * - `hasTextContent` — whether the user typed any non-whitespace text;
 *   used by the server to decide prompt-only vs. attachment-only rendering.
 */
interface PreparedUserMessage {
  prompt: string;
  attachFiles: AttachFile[] | undefined;
  attachments: ChatPromptEvent["attachFiles"];
  hasTextContent: boolean;
}

interface AttachmentFileInfo {
  id: string;
  url: string;
}

interface ResolvedDraftAttachment {
  attachment: ZeroChatAttachment;
  info: AttachmentFileInfo;
}

interface VisualAttachmentDescriptor {
  contentType?: string | null;
  filename?: string | null;
}

interface AttachmentDescriptor extends VisualAttachmentDescriptor {
  size: number;
}

interface PrepareUserMessageOptions {
  selectedModel: string | null | undefined;
  imageRecognitionEnabled: boolean;
}

const VISUAL_ATTACHMENT_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|webp|avif|heic|heif|bmp|svg|mp4|m4v|mov|webm|avi|mkv)$/i;

function isVisualAttachment({
  contentType,
  filename,
}: VisualAttachmentDescriptor): boolean {
  const normalizedContentType = contentType?.toLowerCase() ?? "";
  if (
    normalizedContentType.startsWith("image/") ||
    normalizedContentType.startsWith("video/")
  ) {
    return true;
  }
  return VISUAL_ATTACHMENT_EXTENSION_RE.test(filename ?? "");
}

function isRecognitionCompatibleImage({
  contentType,
  size,
}: AttachmentDescriptor): boolean {
  return (
    size > 0 &&
    size <= ZERO_RECOGNITION_MAX_FILE_BYTES &&
    zeroRecognitionImageMimeTypeSchema.safeParse(contentType).success
  );
}

export function shouldExcludeAttachmentForModel(
  attachment: AttachmentDescriptor,
  selectedModel: string | null | undefined,
  imageRecognitionEnabled: boolean,
): boolean {
  if (
    getModelImageInputSupport(selectedModel) !== "unsupported" ||
    !isVisualAttachment(attachment)
  ) {
    return false;
  }
  return !imageRecognitionEnabled || !isRecognitionCompatibleImage(attachment);
}

export function collectSuccessfulAttachmentInfos(
  attachments: readonly ZeroChatAttachment[],
  results: readonly PromiseSettledResult<AttachmentFileInfo | null>[],
): ResolvedDraftAttachment[] {
  return results.flatMap((result, index) => {
    const attachment = attachments[index];
    if (!attachment || result.status !== "fulfilled" || result.value === null) {
      return [];
    }

    return [{ attachment, info: result.value }];
  });
}

function attachmentUploadFailureMessage(
  attachments: readonly ZeroChatAttachment[],
  results: readonly PromiseSettledResult<AttachmentFileInfo | null>[],
): string | null {
  const failedFilenames = results.flatMap((result, index) => {
    const attachment = attachments[index];
    if (!attachment) {
      return [];
    }
    if (result.status === "rejected" || result.value === null) {
      return [attachment.filename];
    }
    return [];
  });

  if (failedFilenames.length === 0) {
    return null;
  }

  if (failedFilenames.length === 1) {
    return i18n.t(
      ($) => {
        return $.chat.attachments.uploadFailedRetry;
      },
      { filename: failedFilenames[0] },
    );
  }

  return i18n.t(($) => {
    return $.chat.attachments.uploadsFailed;
  });
}

/**
 * Resolves a draft's pending attachments (waits for uploads to finish,
 * rejects failed entries) and shapes the result into both the
 * outbound `AttachFile[]` for the send contract and the optimistic-UI
 * `ChatEvent["attachFiles"]` shape.
 *
 * Returns `null` when the user has typed nothing and no attachments are
 * ready — callers should abort the send in that case.
 *
 * Shared by `sendMessage$` (in-thread follow-ups) and `sendNewThreadMessage$`
 * (first message on a new thread) so both entry points produce identical
 * request bodies.
 */
export const prepareUserMessageFromDraft$ = command(
  async (
    { get },
    draft: DraftSignals,
    prompt: string,
    options: PrepareUserMessageOptions,
    signal: AbortSignal,
  ): Promise<PreparedUserMessage | null> => {
    const draftAttachments = get(draft.attachments$);
    const allAttachments = draftAttachments.filter((attachment) => {
      return !shouldExcludeAttachmentForModel(
        attachment,
        options.selectedModel,
        options.imageRecognitionEnabled,
      );
    });
    const allInfos = await Promise.allSettled(
      allAttachments.map((a) => {
        return get(a.fileInfo$);
      }),
    );
    signal.throwIfAborted();

    const uploadFailureMessage = attachmentUploadFailureMessage(
      allAttachments,
      allInfos,
    );
    if (uploadFailureMessage) {
      throw new Error(uploadFailureMessage);
    }

    const ready = collectSuccessfulAttachmentInfos(allAttachments, allInfos);

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt && ready.length === 0) {
      return null;
    }

    // User prompt is clean text only — file description blocks are appended
    // server-side via buildFullPrompt so the agent gets the [Web file] [ID]
    // format it knows how to download with `zero web download-file`.
    const finalPrompt =
      trimmedPrompt || (ready.length > 0 ? ATTACH_ONLY_PLACEHOLDER : "");

    const attachFiles: AttachFile[] | undefined =
      ready.length > 0
        ? ready.map((r) => {
            return {
              id: r.info.id,
              filename: r.attachment.filename,
              contentType: r.attachment.contentType,
              size: r.attachment.size,
            };
          })
        : undefined;

    const attachments: ChatPromptEvent["attachFiles"] =
      ready.length > 0
        ? ready.map((r) => {
            return {
              id: r.info.id,
              filename: r.attachment.filename,
              contentType: r.attachment.contentType,
              size: r.attachment.size,
              url: r.info.url,
            };
          })
        : undefined;

    return {
      prompt: finalPrompt,
      attachFiles,
      attachments,
      hasTextContent: trimmedPrompt.length > 0,
    };
  },
);
