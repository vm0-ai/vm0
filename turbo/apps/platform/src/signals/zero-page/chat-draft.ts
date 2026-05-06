import { command, computed, state, type Command, type Computed } from "ccstate";
import { resetSignal } from "../utils.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

// ---------------------------------------------------------------------------
// Attachment types (moved from zero-chat.ts)
// ---------------------------------------------------------------------------

interface FileInfo {
  id: string;
  url: string;
}

function uploadContentTypeByExtension(ext: string): string | undefined {
  const contentTypeByExtension: Record<string, string | undefined> = {
    aac: "audio/aac",
    avif: "image/avif",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    flac: "audio/flac",
    gif: "image/gif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    m4a: "audio/mp4",
    md: "text/markdown",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mpga: "audio/mpga",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    pdf: "application/pdf",
    png: "image/png",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    svg: "image/svg+xml",
    txt: "text/plain",
    wav: "audio/wav",
    wave: "audio/wave",
    webm: "video/webm",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return contentTypeByExtension[ext];
}

function inferUploadContentType(file: File): string {
  const explicitType = file.type.split(";")[0]?.trim().toLowerCase();
  if (explicitType && explicitType !== "application/octet-stream") {
    return explicitType;
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext
    ? (uploadContentTypeByExtension(ext) ?? "application/octet-stream")
    : "application/octet-stream";
}

export interface ZeroChatAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Reactive file info (id + url) — loading while uploading, hasData when done. */
  fileInfo$: Computed<Promise<FileInfo | null>>;
  /** Cancel the in-flight upload. Always safe to call (no-op if already completed). */
  cancel$: Command<void, []>;
  /** Start the upload and publish its fileInfo$ promise for later send-time resolution. */
  upload$: Command<Promise<void>, [AbortSignal]>;
}

function createChatAttachment(file: File): ZeroChatAttachment {
  const contentType = inferUploadContentType(file);
  const resetSignal$ = resetSignal();
  const internalPromise$ = state<Promise<FileInfo> | null>(null);

  const fileInfo$ = computed(async (get) => {
    const promise = get(internalPromise$);
    if (promise === null) {
      return null;
    }
    return await promise;
  });

  const cancel$ = command(({ set }) => {
    set(resetSignal$);
  });

  const upload$ = command(async ({ get, set }, parentSignal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroUploadsContract);
    const signal = set(resetSignal$, parentSignal);

    const promise = (async () => {
      // Step 1: ask the server to sign a PUT URL for R2. The file body never
      // travels through the Next.js runtime, which lets us exceed Vercel's
      // serverless body cap and next dev's multipart parser limits.
      const prepared = await accept(
        client.prepare({
          body: {
            filename: file.name,
            contentType,
            size: file.size,
          },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();

      const putRes = await fetch(prepared.body.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "content-type": contentType },
        signal,
      });
      parentSignal.throwIfAborted();

      if (!putRes.ok) {
        throw new Error(
          `storage returned ${putRes.status} ${putRes.statusText}`,
        );
      }

      return { id: prepared.body.id, url: prepared.body.url };
    })();

    set(internalPromise$, promise);

    await promise;
  });

  return {
    filename: file.name,
    contentType,
    size: file.size,
    fileInfo$,
    cancel$,
    upload$,
  };
}

// ---------------------------------------------------------------------------
// DraftSignals — encapsulates per-thread composer state
// ---------------------------------------------------------------------------

export interface DraftSignals {
  input$: Computed<string>;
  setInput$: Command<void, [string]>;
  attachments$: Computed<ZeroChatAttachment[]>;
  uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  restoreAttachments$: Command<void, [PersistedAttachment[]]>;
  removeAttachment$: Command<void, [ZeroChatAttachment]>;
  dragOver$: Computed<boolean>;
  setDragOver$: Command<void, [boolean]>;
  /** Reset all draft state (input, attachments). Called after send. */
  clear$: Command<void, []>;
  /** Seed draft from persisted server data. Only called when local cache was empty. */
  seed$: Command<void, [content: string, attachments: ZeroChatAttachment[]]>;
}

/**
 * Reconstructs a ZeroChatAttachment from persisted attachment metadata.
 * The fileInfo$ resolves immediately since the file was already uploaded.
 */
export function createRestoredAttachment(
  persisted: PersistedAttachment,
): ZeroChatAttachment {
  const fileInfo$ = computed(
    (): Promise<{ id: string; url: string } | null> => {
      return Promise.resolve({ id: persisted.id, url: persisted.url });
    },
  );

  const cancel$ = command(() => {
    // no-op: already uploaded, nothing to cancel
  });

  // upload$ accepts a signal parameter to match the ZeroChatAttachment interface.
  // The file is already uploaded, so this is a no-op.
  const upload$ = command((_visitor, _signal: AbortSignal): Promise<void> => {
    return Promise.resolve();
  });

  return {
    filename: persisted.filename,
    contentType: persisted.contentType,
    size: persisted.size,
    fileInfo$,
    cancel$,
    upload$,
  };
}

export function createDraftSignals(): DraftSignals {
  const internalInput$ = state("");
  const internalAttachments$ = state<ZeroChatAttachment[]>([]);
  const internalDragOver$ = state(false);

  const input$ = computed((get) => {
    return get(internalInput$);
  });
  const setInput$ = command(({ set }, value: string) => {
    set(internalInput$, value);
  });

  const attachments$ = computed((get) => {
    return get(internalAttachments$);
  });

  const uploadAttachment$ = command(
    async ({ set }, file: File, signal: AbortSignal) => {
      const attachment = createChatAttachment(file);
      set(internalAttachments$, (prev) => {
        return [...prev, attachment];
      });

      await set(attachment.upload$, signal);
    },
  );

  const restoreAttachments$ = command(
    ({ set }, persisted: PersistedAttachment[]) => {
      if (persisted.length === 0) {
        return;
      }
      const restored = persisted.map(createRestoredAttachment);
      set(internalAttachments$, (prev) => {
        return [...prev, ...restored];
      });
    },
  );

  const removeAttachment$ = command(
    ({ set }, attachment: ZeroChatAttachment) => {
      set(attachment.cancel$);
      set(internalAttachments$, (prev) => {
        return prev.filter((a) => {
          return a !== attachment;
        });
      });
    },
  );

  const dragOver$ = computed((get) => {
    return get(internalDragOver$);
  });
  const setDragOver$ = command(({ set }, value: boolean) => {
    set(internalDragOver$, value);
  });

  const clear$ = command(({ get, set }) => {
    set(internalInput$, "");
    // Cancel all pending uploads before clearing
    for (const attachment of get(internalAttachments$)) {
      set(attachment.cancel$);
    }
    set(internalAttachments$, []);
    set(internalDragOver$, false);
  });

  const seed$ = command(
    ({ set }, content: string, attachments: ZeroChatAttachment[]) => {
      set(internalInput$, content);
      set(internalAttachments$, attachments);
    },
  );

  return {
    input$,
    setInput$,
    attachments$,
    uploadAttachment$,
    restoreAttachments$,
    removeAttachment$,
    dragOver$,
    setDragOver$,
    clear$,
    seed$,
  };
}

// ---------------------------------------------------------------------------
// Draft storage — per-thread map + talk-page singleton
// ---------------------------------------------------------------------------

const internalDraftMap$ = state<Record<string, DraftSignals>>({});

const internalTalkDraft$ = state(createDraftSignals());

export const talkDraft$ = computed((get) => {
  return get(internalTalkDraft$);
});

/**
 * The current draft for the active route.
 * Returns `talkDraft$` when there is no chatThreadId (talk page / landing),
 * or the thread's draft from the map.
 */
const currentDraft$ = computed((get) => {
  const threadId = get(currentChatThreadId$);
  if (!threadId) {
    return get(talkDraft$);
  }
  return get(internalDraftMap$)[threadId] ?? null;
});

const zeroChatInput$ = computed((get) => {
  const draft = get(currentDraft$);
  return draft ? get(draft.input$) : "";
});

export const zeroChatAttachments$ = computed((get) => {
  const draft = get(currentDraft$);
  return draft ? get(draft.attachments$) : [];
});

export const uploadZeroAttachment$ = command(
  async ({ get, set }, file: File, signal: AbortSignal) => {
    const draft = get(currentDraft$);
    if (draft) {
      await set(draft.uploadAttachment$, file, signal);
    }
  },
);

export const restoreZeroAttachments$ = command(
  ({ get, set }, attachments: PersistedAttachment[]) => {
    const draft = get(currentDraft$);
    if (draft) {
      set(draft.restoreAttachments$, attachments);
    }
  },
);

export const removeZeroAttachment$ = command(
  ({ get, set }, attachment: ZeroChatAttachment) => {
    const draft = get(currentDraft$);
    if (draft) {
      set(draft.removeAttachment$, attachment);
    }
  },
);

export const zeroDragOver$ = computed((get) => {
  const draft = get(currentDraft$);
  return draft ? get(draft.dragOver$) : false;
});

export const setZeroDragOver$ = command(({ get, set }, value: boolean) => {
  const draft = get(currentDraft$);
  if (draft) {
    set(draft.setDragOver$, value);
  }
});

/**
 * True when the current draft has content to send: either non-empty text or
 * at least one attachment. Used as single source of truth for send enablement.
 */
export const canSendZeroChat$ = computed((get) => {
  return (
    get(zeroChatInput$).trim() !== "" || get(zeroChatAttachments$).length > 0
  );
});
