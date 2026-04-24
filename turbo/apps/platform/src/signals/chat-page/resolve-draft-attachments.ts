import { command } from "ccstate";
import type {
  AttachFile,
  PagedChatMessage,
} from "@vm0/core/contracts/chat-threads";
import type {
  DraftSignals,
  ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";

/**
 * Placeholder stored as the prompt when the user sends only files with no
 * typed text, so the `chatMessagesContract.send` body passes its `min(1)`
 * validation. The UI strips this placeholder from `PagedUserMessage` so the
 * bubble shows only the download chips.
 */
export const ATTACH_ONLY_PLACEHOLDER = "(see attached files)";

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
  attachments: PagedChatMessage["attachFiles"];
  hasTextContent: boolean;
}

/**
 * Resolves a draft's pending attachments (waits for uploads to finish,
 * filters out cancelled/failed entries) and shapes the result into both the
 * outbound `AttachFile[]` for the send contract and the optimistic-UI
 * `PagedChatMessage["attachFiles"]` shape.
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
    signal: AbortSignal,
  ): Promise<PreparedUserMessage | null> => {
    const allAttachments = get(draft.attachments$);
    const allInfos = await Promise.all(
      allAttachments.map((a) => {
        return get(a.fileInfo$);
      }),
    );
    signal.throwIfAborted();

    const ready = allAttachments
      .map((a, i) => {
        return { attachment: a, info: allInfos[i] };
      })
      .filter(
        (
          r,
        ): r is {
          attachment: ZeroChatAttachment;
          info: { id: string; url: string };
        } => {
          return r.info !== null;
        },
      );

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

    const attachments: PagedChatMessage["attachFiles"] =
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
