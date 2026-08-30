import { command } from "ccstate";
import { timeout } from "signal-timers";
import { createChildAbortController, settle } from "../utils.ts";
import type { ResolvedAttachFile } from "@okouai/api-contracts/contracts/chat-threads";
import {
  uploadFileToStorage$,
  type ChatAttachment,
} from "../okou-page/chat-draft.ts";
import {
  describeAnnotation,
  isAnnotationMeaningful,
} from "../okou-page/image-annotation.ts";
import { flattenAnnotatedImage } from "../okou-page/flatten-annotated-image.ts";
import { composerImageAnnotationEnabled$ } from "../external/feature-switch.ts";

/**
 * A decode that neither loads nor errors — a stalled CDN connection is the
 * common way — leaves the image element waiting forever, and the send waits
 * with it. The message never leaves and nothing explains why. Past this
 * deadline the copy is abandoned and the notes go on their own. Three seconds
 * is several times what a large screenshot needs to decode and re-encode, and
 * short enough that a stall reads as a slow send rather than a dead one.
 */
const FLATTEN_DEADLINE_MS = 3000;

interface AttachmentToFlatten {
  readonly attachment: ChatAttachment;
  readonly info: { id: string; url: string; contentType: string };
}

export interface FlattenedAttachment {
  /**
   * The rendered copy, already uploaded and pointing back at the original.
   * Absent when rendering or uploading it failed — the notes still travel.
   */
  readonly file?: ResolvedAttachFile;
  /** The marks as words, appended to the prompt so the agent can read them. */
  readonly description: string | null;
}

/**
 * Renders every annotated image in a send into a flattened copy and uploads it.
 *
 * Flattening deliberately happens here, at send time, rather than when the user
 * closes the editor: until the message leaves, the marks are still editable, and
 * the original bytes stay the only thing that has been stored.
 *
 * A failure to flatten does not fail the send. Losing the marks is bad; losing
 * the whole message because a canvas could not encode is worse, so the original
 * still goes out on its own and the notes still reach the agent as text.
 */
export const flattenAnnotatedAttachments$ = command(
  async (
    { get, set },
    ready: readonly AttachmentToFlatten[],
    signal: AbortSignal,
  ): Promise<Map<string, FlattenedAttachment>> => {
    const results = new Map<string, FlattenedAttachment>();
    if (!get(composerImageAnnotationEnabled$)) {
      return results;
    }

    for (const entry of ready) {
      const annotation = get(entry.attachment.annotation$);
      if (
        !annotation ||
        !isAnnotationMeaningful(annotation) ||
        !entry.info.contentType.startsWith("image/")
      ) {
        continue;
      }

      const description = describeAnnotation(
        entry.attachment.filename,
        annotation,
      );

      const deadline = createChildAbortController(signal);
      timeout(
        () => {
          deadline.abort(new Error("Timed out flattening an annotated image"));
        },
        FLATTEN_DEADLINE_MS,
        { signal: deadline.signal },
      );
      const flattened = await settle(
        flattenAnnotatedImage(
          entry.info.url,
          annotation,
          entry.attachment.filename,
          deadline.signal,
        ),
        signal,
      );
      deadline.abort();
      if (!flattened.ok) {
        results.set(entry.info.id, { description });
        continue;
      }

      const uploaded = await settle(
        set(uploadFileToStorage$, flattened.value.file, signal),
        signal,
      );
      if (!uploaded.ok) {
        results.set(entry.info.id, { description });
        continue;
      }

      results.set(entry.info.id, {
        file: {
          id: uploaded.value.id,
          filename: flattened.value.file.name,
          contentType: "image/png",
          size: flattened.value.file.size,
          url: uploaded.value.url,
          annotatedFromFileId: entry.info.id,
          annotation,
        },
        description,
      });
    }

    return results;
  },
);
