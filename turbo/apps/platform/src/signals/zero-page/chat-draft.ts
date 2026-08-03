import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay } from "signal-timers";
import { onRejection, resetSignal, settle, tapError } from "../utils.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { IN_VITEST } from "../../env.ts";
import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { EditorDocumentSnapshot } from "./user-message-document-codec.ts";
import { i18n } from "../../i18n/index.ts";

// ---------------------------------------------------------------------------
// Attachment types (moved from zero-chat.ts)
// ---------------------------------------------------------------------------

interface FileInfo {
  id: string;
  url: string;
}

const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MAX_PART_UPLOAD_ATTEMPTS = 5;
const PART_UPLOAD_RETRY_BASE_DELAY_MS = 250;
const MULTIPART_ABORT_TIMEOUT_MS = 5000;

interface MultipartUploadReference {
  id: string;
  filename: string;
  uploadId: string;
}

const abortMultipartUpload$ = command(
  async (
    { get },
    upload: MultipartUploadReference,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(zeroUploadsContract);
    await tapError(
      accept(
        client.abortMultipart({
          body: upload,
          fetchOptions: {
            keepalive: true,
            signal,
          },
        }),
        [200],
        signal,
        { showErrorToast: false },
      ),
    );
  },
);

function uploadContentTypeByExtension(ext: string): string | undefined {
  const contentTypeByExtension: Record<string, string | undefined> = {
    aac: "audio/aac",
    "7z": "application/x-7z-compressed",
    ai: "application/postscript",
    avif: "image/avif",
    bmp: "image/bmp",
    bz2: "application/x-bzip2",
    csv: "text/csv",
    db: "application/vnd.sqlite3",
    doc: "application/msword",
    docm: "application/vnd.ms-word.document.macroenabled.12",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dotm: "application/vnd.ms-word.template.macroenabled.12",
    dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    epub: "application/epub+zip",
    flac: "audio/flac",
    gif: "image/gif",
    gz: "application/gzip",
    heic: "image/heic",
    heif: "image/heif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    key: "application/vnd.apple.keynote",
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
    numbers: "application/vnd.apple.numbers",
    pages: "application/vnd.apple.pages",
    parquet: "application/vnd.apache.parquet",
    pdf: "application/pdf",
    png: "image/png",
    potm: "application/vnd.ms-powerpoint.template.macroenabled.12",
    potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
    ppsm: "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ppt: "application/vnd.ms-powerpoint",
    pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    psd: "image/vnd.adobe.photoshop",
    rar: "application/vnd.rar",
    rtf: "application/rtf",
    sqlite: "application/vnd.sqlite3",
    sqlite3: "application/vnd.sqlite3",
    svg: "image/svg+xml",
    tar: "application/x-tar",
    tgz: "application/gzip",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
    tsv: "text/tab-separated-values",
    wav: "audio/wav",
    wave: "audio/wave",
    webm: "video/webm",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xltm: "application/vnd.ms-excel.template.macroenabled.12",
    xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    xml: "application/xml",
    xz: "application/x-xz",
    yaml: "application/yaml",
    yml: "application/yaml",
    zip: "application/zip",
  };
  return contentTypeByExtension[ext];
}

export function inferUploadContentType(file: File): string {
  const explicitType = file.type.split(";")[0]?.trim().toLowerCase();
  if (explicitType && explicitType !== "application/octet-stream") {
    return explicitType;
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext
    ? (uploadContentTypeByExtension(ext) ?? "application/octet-stream")
    : "application/octet-stream";
}

async function uploadPartWithRetry(
  uploadUrl: string,
  body: Blob,
  contentType: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PART_UPLOAD_ATTEMPTS; attempt += 1) {
    const result = await settle(
      fetch(uploadUrl, {
        method: "PUT",
        body,
        headers: { "content-type": contentType },
        signal,
      }),
      signal,
    );
    if (result.ok) {
      if (result.value.ok) {
        return;
      }
      if (attempt === MAX_PART_UPLOAD_ATTEMPTS) {
        throw new Error(
          `storage returned ${result.value.status} ${result.value.statusText}`,
        );
      }
    } else if (attempt === MAX_PART_UPLOAD_ATTEMPTS) {
      throw result.error;
    }
    await delay(
      IN_VITEST ? 0 : PART_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      { signal },
    );
  }
  throw new Error("Multipart upload retry loop ended unexpectedly");
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
      // Step 1: ask the server to sign either one PUT URL or retryable R2
      // multipart URLs. The file body never travels through the app runtime.
      const prepared = await accept(
        client.prepare({
          body: {
            filename: file.name,
            contentType,
            size: file.size,
            supportsUploadHeaders: true,
            ...(file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES
              ? { multipart: true as const }
              : {}),
          },
          fetchOptions: { signal },
        }),
        [200],
      );

      if ("multipart" in prepared.body) {
        const multipart = prepared.body.multipart;
        return await onRejection(
          (async () => {
            signal.throwIfAborted();
            for (const part of multipart.parts) {
              const start = (part.partNumber - 1) * multipart.partSize;
              const end = Math.min(start + multipart.partSize, file.size);
              await uploadPartWithRetry(
                part.uploadUrl,
                file.slice(start, end, prepared.body.contentType),
                prepared.body.contentType,
                signal,
              );
            }

            const completed = await accept(
              client.completeMultipart({
                body: {
                  id: prepared.body.id,
                  filename: prepared.body.filename,
                  uploadId: multipart.uploadId,
                  partCount: multipart.parts.length,
                },
                fetchOptions: { signal },
              }),
              [200],
            );
            signal.throwIfAborted();
            return completed.body;
          })(),
          async () => {
            const cleanupSignal = AbortSignal.timeout(
              MULTIPART_ABORT_TIMEOUT_MS,
            );
            await set(
              abortMultipartUpload$,
              {
                id: prepared.body.id,
                filename: prepared.body.filename,
                uploadId: multipart.uploadId,
              },
              cleanupSignal,
            );
          },
        );
      }

      signal.throwIfAborted();
      const putRes = await fetch(prepared.body.uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "content-type": prepared.body.contentType,
          ...prepared.body.uploadHeaders,
        },
        signal,
      });
      signal.throwIfAborted();

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
  hasInput$: Computed<boolean>;
  readInput$: Command<string, []>;
  setInput$: Command<void, [string]>;
  appendInput$: Command<void, [string]>;
  setInputSyncTarget$: Command<void, [DraftInputSyncTarget | null]>;
  takeRestoredUserMessage$: Command<UserMessageDocument | null, []>;
  readEditorDocument$: Command<EditorDocumentSnapshot | null, []>;
  setEditorDocument$: Command<void, [EditorDocumentSnapshot | null]>;
  generationTemplate$: Computed<GenerationTemplateRequest | undefined>;
  setGenerationTemplate$: Command<
    void,
    [GenerationTemplateRequest | undefined]
  >;
  attachments$: Computed<ZeroChatAttachment[]>;
  attachmentUploadsReady$: Computed<boolean | Promise<boolean>>;
  uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  restoreAttachments$: Command<void, [PersistedAttachment[]]>;
  removeAttachment$: Command<void, [ZeroChatAttachment]>;
  dragOver$: Computed<boolean>;
  setDragOver$: Command<void, [boolean]>;
  /** Reset all draft state (input, template, attachments). Called after send. */
  clear$: Command<void, []>;
  /** Seed draft from persisted server data. Only called when local cache was empty. */
  seed$: Command<void, [DraftSeed]>;
}

interface DraftSeed {
  content: string;
  userMessage: UserMessageDocument | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  attachments: ZeroChatAttachment[];
}

export interface DraftInputSyncTarget {
  syncInput(value: string): void;
  syncUserMessage(value: UserMessageDocument): void;
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

function createDraftInputSignals() {
  const internalInput$ = state("");
  const internalInputSyncTarget$ = state<DraftInputSyncTarget | null>(null);
  const input$ = computed((get) => {
    return get(internalInput$);
  });
  const hasInput$ = computed((get) => {
    return get(internalInput$).trim().length > 0;
  });
  const readInput$ = command(({ get }) => {
    return get(internalInput$);
  });
  const syncInput$ = command(({ get }, value: string) => {
    get(internalInputSyncTarget$)?.syncInput(value);
  });
  const syncUserMessage$ = command(({ get }, value: UserMessageDocument) => {
    const target = get(internalInputSyncTarget$);
    if (!target) {
      return false;
    }
    target.syncUserMessage(value);
    return true;
  });
  const setInputSyncTarget$ = command(
    ({ set }, target: DraftInputSyncTarget | null) => {
      set(internalInputSyncTarget$, target);
    },
  );
  const setInput$ = command(({ set }, value: string) => {
    set(syncInput$, value);
    set(internalInput$, value);
  });
  const appendInput$ = command(({ get, set }, value: string) => {
    const text = value.trim();
    if (!text) {
      return;
    }
    const base = get(internalInput$);
    const separator = base.length > 0 && !base.endsWith(" ") ? " " : "";
    set(setInput$, `${base}${separator}${text}`);
  });
  return {
    input$,
    hasInput$,
    readInput$,
    setInput$,
    appendInput$,
    setInputSyncTarget$,
    syncUserMessage$,
  };
}

function createDraftDocumentSignals() {
  let restoredUserMessage: UserMessageDocument | null = null;
  let editorDocument: EditorDocumentSnapshot | null = null;
  const setRestoredUserMessage$ = command(
    (_context, value: UserMessageDocument | null) => {
      restoredUserMessage = value;
    },
  );
  const takeRestoredUserMessage$ = command(() => {
    const value = restoredUserMessage;
    restoredUserMessage = null;
    return value;
  });
  const readEditorDocument$ = command(() => {
    return editorDocument;
  });
  const setEditorDocument$ = command(
    (_context, value: EditorDocumentSnapshot | null) => {
      editorDocument = value;
    },
  );
  return {
    setRestoredUserMessage$,
    takeRestoredUserMessage$,
    readEditorDocument$,
    setEditorDocument$,
  };
}

function createDraftLifecycleSignals({
  draftInput,
  draftDocument,
  internalGenerationTemplate$,
  internalAttachments$,
  internalDragOver$,
}: {
  draftInput: ReturnType<typeof createDraftInputSignals>;
  draftDocument: ReturnType<typeof createDraftDocumentSignals>;
  internalGenerationTemplate$: State<GenerationTemplateRequest | undefined>;
  internalAttachments$: State<ZeroChatAttachment[]>;
  internalDragOver$: State<boolean>;
}) {
  const clear$ = command(({ get, set }) => {
    set(draftInput.setInput$, "");
    set(draftDocument.setRestoredUserMessage$, null);
    set(draftDocument.setEditorDocument$, null);
    set(internalGenerationTemplate$, undefined);
    const attachments = get(internalAttachments$);
    for (const attachment of attachments) {
      set(attachment.cancel$);
    }
    if (attachments.length > 0) {
      set(internalAttachments$, []);
    }
    set(internalDragOver$, false);
  });

  const seed$ = command(({ set }, value: DraftSeed) => {
    set(draftDocument.setEditorDocument$, null);
    set(draftDocument.setRestoredUserMessage$, value.userMessage);
    set(internalGenerationTemplate$, value.generationTemplate);
    set(internalAttachments$, value.attachments);
    set(draftInput.setInput$, value.content);
    if (
      value.userMessage &&
      set(draftInput.syncUserMessage$, value.userMessage)
    ) {
      set(draftDocument.takeRestoredUserMessage$);
    }
  });

  return { clear$, seed$ };
}

export function createDraftSignals(): DraftSignals {
  const draftInput = createDraftInputSignals();
  const draftDocument = createDraftDocumentSignals();
  const internalGenerationTemplate$ = state<
    GenerationTemplateRequest | undefined
  >(undefined);
  const internalAttachments$ = state<ZeroChatAttachment[]>([]);
  const internalDragOver$ = state(false);

  const generationTemplate$ = computed((get) => {
    return get(internalGenerationTemplate$);
  });
  const setGenerationTemplate$ = command(
    ({ set }, value: GenerationTemplateRequest | undefined) => {
      set(internalGenerationTemplate$, value);
    },
  );

  const attachments$ = computed((get) => {
    return get(internalAttachments$);
  });

  const attachmentUploadsReady$ = computed(
    (get): boolean | Promise<boolean> => {
      const attachments = get(internalAttachments$);
      if (attachments.length === 0) {
        return true;
      }
      const fileInfos = attachments.map((attachment) => {
        return get(attachment.fileInfo$);
      });
      return (async () => {
        const infos = await Promise.all(fileInfos);
        if (
          infos.some((info) => {
            return info === null;
          })
        ) {
          throw new Error("Attachment upload did not start");
        }
        return true;
      })();
    },
  );

  const uploadAttachment$ = command(
    async ({ set }, file: File, signal: AbortSignal) => {
      const attachment = createChatAttachment(file);
      const upload = set(attachment.upload$, signal);
      set(internalAttachments$, (prev) => {
        return [...prev, attachment];
      });

      await tapError(upload, () => {
        set(internalAttachments$, (prev) => {
          return prev.filter((a) => {
            return a !== attachment;
          });
        });
        toast.error(
          i18n.t(
            ($) => {
              return $.chat.attachments.uploadFailed;
            },
            { filename: file.name },
          ),
        );
      });
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

  const { clear$, seed$ } = createDraftLifecycleSignals({
    draftInput,
    draftDocument,
    internalGenerationTemplate$,
    internalAttachments$,
    internalDragOver$,
  });

  return {
    ...draftInput,
    takeRestoredUserMessage$: draftDocument.takeRestoredUserMessage$,
    readEditorDocument$: draftDocument.readEditorDocument$,
    setEditorDocument$: draftDocument.setEditorDocument$,
    generationTemplate$,
    setGenerationTemplate$,
    attachments$,
    attachmentUploadsReady$,
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
// Draft storage — talk-page singleton
// ---------------------------------------------------------------------------

const internalTalkDraft$ = state(createDraftSignals());

export const talkDraft$ = computed((get) => {
  return get(internalTalkDraft$);
});

export const setTalkDraft$ = command(({ set }, draft: DraftSignals) => {
  set(internalTalkDraft$, draft);
});
