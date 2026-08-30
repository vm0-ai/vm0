import { command } from "ccstate";
import type { ResolvedAttachFile } from "@okouai/api-contracts/contracts/chat-threads";
import { getModelImageInputSupport } from "@okouai/api-contracts/contracts/model-providers";
import type { DraftSignals, ChatAttachment } from "../okou-page/chat-draft.ts";
import { i18n } from "../../i18n/index.ts";
import { flattenAnnotatedAttachments$ } from "./flatten-annotated-attachments.ts";

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
 * - `attachments` — upload metadata used only to build canonical file parts.
 * - `hasTextContent` — whether the user typed any non-whitespace text;
 *   used by the server to decide prompt-only vs. attachment-only rendering.
 */
interface PreparedUserMessage {
  prompt: string;
  attachments: ResolvedAttachFile[] | undefined;
  hasTextContent: boolean;
}

interface AttachmentFileInfo {
  id: string;
  url: string;
  contentType: string;
}

interface ResolvedDraftAttachment {
  attachment: ChatAttachment;
  info: AttachmentFileInfo;
}

interface VisualAttachmentDescriptor {
  contentType?: string | null;
  filename?: string | null;
}

interface PrepareUserMessageOptions {
  excludeVisualAttachments?: boolean;
}

const VISUAL_ATTACHMENT_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|webp|avif|heic|heif|bmp|svg|mp4|m4v|mov|webm|avi|mkv)$/i;

export function isVisualAttachment({
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

export function shouldExcludeVisualAttachmentsForModel(
  selectedModel: string | null | undefined,
  imageRecognitionEnabled: boolean,
): boolean {
  return (
    !imageRecognitionEnabled &&
    getModelImageInputSupport(selectedModel) === "unsupported"
  );
}

export function collectSuccessfulAttachmentInfos(
  attachments: readonly ChatAttachment[],
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
  attachments: readonly ChatAttachment[],
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
 * canonical file parts for the outbound user-message document.
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
    { get, set },
    draft: DraftSignals,
    prompt: string,
    options: PrepareUserMessageOptions,
    signal: AbortSignal,
  ): Promise<PreparedUserMessage | null> => {
    const draftAttachments = get(draft.attachments$);
    const allAttachments = options.excludeVisualAttachments
      ? draftAttachments.filter((attachment) => {
          return !isVisualAttachment(attachment);
        })
      : draftAttachments;
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
    // format it knows how to download with `okou web download-file`.
    const finalPrompt =
      trimmedPrompt || (ready.length > 0 ? ATTACH_ONLY_PLACEHOLDER : "");

    const flattened = await set(flattenAnnotatedAttachments$, ready, signal);
    signal.throwIfAborted();

    const attachments: ResolvedAttachFile[] | undefined =
      ready.length > 0
        ? ready.flatMap((r) => {
            const original: ResolvedAttachFile = {
              id: r.info.id,
              filename: r.attachment.filename,
              contentType: r.info.contentType,
              size: r.attachment.size,
              url: r.info.url,
            };
            const copy = flattened.get(r.info.id)?.file;
            // The flattened copy leads, because it is what the vision model
            // reads; the untouched original rides behind it so the bubble can
            // still offer it and nothing the user uploaded is lost.
            return copy ? [copy, original] : [original];
          })
        : undefined;

    const markNotes = ready.flatMap((r) => {
      const description = flattened.get(r.info.id)?.description;
      return description ? [description] : [];
    });

    // Notes are real text, so they displace the attachment-only placeholder
    // rather than stacking on top of it.
    const promptBody = markNotes.length > 0 ? trimmedPrompt : finalPrompt;

    return {
      prompt: [promptBody, ...markNotes].filter(Boolean).join("\n\n"),
      attachments,
      hasTextContent: trimmedPrompt.length > 0 || markNotes.length > 0,
    };
  },
);
