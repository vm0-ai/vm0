import { command, computed, state, type Command, type Computed } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { resetSignal, createDeferredPromise } from "../utils.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import type { PersistedAttachment } from "@vm0/core/contracts/chat-threads";
import { zeroUploadsContract } from "@vm0/core/contracts/zero-uploads";

// ---------------------------------------------------------------------------
// Attachment types (moved from zero-chat.ts)
// ---------------------------------------------------------------------------

interface FileInfo {
  id: string;
  url: string;
}

export interface ZeroChatAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Reactive file info (id + url) — loading while uploading, hasData when done. */
  fileInfo$: Computed<Promise<FileInfo | null>>;
  /** Cancel the in-flight upload. Always safe to call (no-op if already completed). */
  cancel$: Command<void, []>;
  /** Start the upload. Accepts an external signal for cascade abort (e.g. page navigation). */
  upload$: Command<Promise<void>, [AbortSignal]>;
}

function createChatAttachment(file: File): ZeroChatAttachment {
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
    const deferred = createDeferredPromise<FileInfo>(signal);
    set(internalPromise$, deferred.promise);

    // Step 1: ask the server to sign a PUT URL for R2. The file body never
    // travels through the Next.js runtime, which lets us exceed Vercel's
    // serverless body cap and next dev's multipart parser limits.
    //
    // Toast is disabled here so upload errors are surfaced through a single
    // path in `uploadAttachment$`, which also removes the failed chip.
    const prepared = await accept(
      client.prepare({
        body: {
          filename: file.name,
          contentType: file.type,
          size: file.size,
        },
        fetchOptions: { signal },
      }),
      [200],
      { toast: false },
    );
    parentSignal.throwIfAborted();

    // Step 2: PUT the file bytes straight to R2 using the presigned URL.
    // Do NOT forward auth headers or cookies — the URL's signature is the
    // only credential R2 accepts, and adding others trips CORS.
    const putRes = await fetch(prepared.body.uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "content-type": file.type },
      signal,
    });
    parentSignal.throwIfAborted();

    if (!putRes.ok) {
      throw new Error(`storage returned ${putRes.status} ${putRes.statusText}`);
    }

    deferred.resolve({ id: prepared.body.id, url: prepared.body.url });
  });

  return {
    filename: file.name,
    contentType: file.type,
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

      await set(attachment.upload$, signal).catch((error: unknown) => {
        // Drop the failed chip so the composer doesn't show an orphan.
        // `removeAttachment$` may have already removed it on user cancel;
        // filter is a no-op in that case.
        set(internalAttachments$, (prev) => {
          return prev.filter((a) => {
            return a !== attachment;
          });
        });

        // Aborts come from user cancel (X on chip) or external signal
        // (page navigation) — neither is an error condition.
        const isAbort = error instanceof Error && error.name === "AbortError";
        if (isAbort) {
          return;
        }

        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to upload ${file.name}: ${message}`);
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
