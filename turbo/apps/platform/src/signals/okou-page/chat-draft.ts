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
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { apiClient$ } from "../api-client.ts";
import { rootSignal$ } from "../root-signal.ts";
import { accept } from "../../lib/accept.ts";
import { IN_VITEST } from "../../env.ts";
import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
  ImageAnnotation,
} from "@okouai/api-contracts/contracts/chat-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { EditorDocumentSnapshot } from "./user-message-document-codec.ts";
import { i18n } from "../../i18n/index.ts";

// ---------------------------------------------------------------------------
// Attachment types (moved from zero-chat.ts)
// ---------------------------------------------------------------------------

interface FileInfo {
  id: string;
  url: string;
  contentType: string;
}

function uploadFileInfo(
  file: Pick<FileInfo, "id" | "url">,
  contentType: string,
): FileInfo {
  return { id: file.id, url: file.url, contentType };
}

type AttachmentUploadState =
  | {
      readonly status: "pending";
      readonly promise: Promise<FileInfo> | null;
    }
  | {
      readonly status: "uploaded";
      readonly fileInfo: FileInfo;
    };

const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MAX_PART_UPLOAD_ATTEMPTS = 5;
const PART_UPLOAD_RETRY_BASE_DELAY_MS = 250;
const MULTIPART_ABORT_TIMEOUT_MS = 5000;
const noUploadPending$ = computed((): boolean => {
  return false;
});

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
    const client = get(apiClient$)(uploadsContract);
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
    har: "application/json",
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

/**
 * Presigns, transfers and finalizes one file, returning its canonical info.
 *
 * Extracted from the draft attachment closure so the send path can push a
 * flattened annotated copy through exactly the same route rather than growing
 * a second, subtly different uploader. The file body never travels through the
 * app runtime in either case.
 */
export const uploadFileToStorage$ = command(
  async ({ get, set }, file: File, signal: AbortSignal): Promise<FileInfo> => {
    const createClient = get(apiClient$);
    const client = createClient(uploadsContract);
    const contentType = inferUploadContentType(file);

    // Step 1: ask the server to sign either one PUT URL or retryable R2
    // multipart URLs. The file body never travels through the app runtime.
    const prepared = await accept(
      client.prepare({
        body: {
          filename: file.name,
          contentType,
          size: file.size,
          ...(file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES
            ? { multipart: true as const }
            : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    if ("multipart" in prepared.body) {
      const multipart = prepared.body.multipart;
      let completionStarted = false;
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

          signal.throwIfAborted();
          completionStarted = true;
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
          return uploadFileInfo(completed.body, prepared.body.contentType);
        })(),
        async () => {
          // Aborting after completion starts can remove the upload while R2
          // is still finalizing it, so only clean up pre-completion failures.
          if (completionStarted) {
            return;
          }
          const cleanupSignal = AbortSignal.timeout(MULTIPART_ABORT_TIMEOUT_MS);
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
      throw new Error(`storage returned ${putRes.status} ${putRes.statusText}`);
    }

    return uploadFileInfo(prepared.body, prepared.body.contentType);
  },
);

export interface ChatAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Load state of the chip's image thumbnail, for image attachments. */
  imageLoad: ImageLoadSignals;
  /** Reactive file info (id + url) — loading while uploading, hasData when done. */
  fileInfo$: Computed<Promise<FileInfo | null>>;
  /** Synchronous upload state used to guard composer submission. */
  uploadPending$: Computed<boolean>;
  /** Cancel the in-flight upload. Always safe to call (no-op if already completed). */
  cancel$: Command<void, []>;
  /** Start the upload and publish its fileInfo$ promise for later send-time resolution. */
  upload$: Command<Promise<void>, [AbortSignal]>;
  /**
   * Marks drawn on this image but not sent yet. They live beside the file
   * rather than inside it: the uploaded bytes are never rewritten, so the
   * editor can reopen fully editable and the original stays downloadable.
   */
  annotation$: Computed<ImageAnnotation | null>;
  setAnnotation$: Command<void, [ImageAnnotation | null]>;
}

function createChatAttachment(file: File): ChatAttachment {
  const contentType = inferUploadContentType(file);
  const internalAnnotation$ = state<ImageAnnotation | null>(null);
  const annotation$ = computed((get) => {
    return get(internalAnnotation$);
  });
  const setAnnotation$ = command(
    ({ set }, annotation: ImageAnnotation | null): void => {
      set(internalAnnotation$, annotation);
    },
  );
  const imageLoad = createImageLoadSignals();
  const resetSignal$ = resetSignal();
  const internalUpload$ = state<AttachmentUploadState>({
    status: "pending",
    promise: null,
  });

  const fileInfo$ = computed(async (get) => {
    const upload = get(internalUpload$);
    if (upload.status === "uploaded") {
      return upload.fileInfo;
    }
    if (upload.promise === null) {
      return null;
    }
    return await upload.promise;
  });
  const uploadPending$ = computed((get): boolean => {
    return get(internalUpload$).status === "pending";
  });
  const cancel$ = command(({ set }) => {
    set(resetSignal$);
  });

  const upload$ = command(async ({ set }, parentSignal: AbortSignal) => {
    const signal = set(resetSignal$, parentSignal);
    const promise = set(uploadFileToStorage$, file, signal);
    set(internalUpload$, { status: "pending", promise });
    const fileInfo = await promise;
    signal.throwIfAborted();
    set(internalUpload$, { status: "uploaded", fileInfo });
  });

  return {
    filename: file.name,
    contentType,
    size: file.size,
    imageLoad,
    fileInfo$,
    uploadPending$,
    cancel$,
    upload$,
    annotation$,
    setAnnotation$,
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
  attachments$: Computed<ChatAttachment[]>;
  attachmentUploadsReady$: Computed<boolean>;
  uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  /**
   * Adds persisted attachments to the draft and drops the ones whose artifact
   * no longer resolves for this account.
   */
  restoreAttachments$: Command<
    Promise<boolean>,
    [PersistedAttachment[], AbortSignal]
  >;
  removeAttachment$: Command<void, [ChatAttachment]>;
  dragOver$: Computed<boolean>;
  setDragOver$: Command<void, [boolean]>;
  /** Reset all draft state (input, template, attachments). Called after send. */
  clear$: Command<void, []>;
  /**
   * Seed draft from persisted server data. Only called when local cache was
   * empty. The draft is visible immediately; the returned promise settles once
   * unresolvable attachments have been dropped.
   */
  seed$: Command<Promise<boolean>, [DraftSeed, AbortSignal]>;
}

interface DraftSeed {
  content: string;
  userMessage: UserMessageDocument | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  attachments: ChatAttachment[];
}

export interface DraftInputSyncTarget {
  syncInput(value: string): void;
  syncUserMessage(value: UserMessageDocument): void;
}

/**
 * Reconstructs a ChatAttachment from persisted attachment metadata.
 *
 * The persisted id is an externally managed reference: the artifact is stored
 * per user, so a saved draft, a forwarded message, or a pasted chat payload can
 * carry an id the current account cannot read. `fileInfo$` resolves it once
 * against the current account and reports `null` when it no longer resolves,
 * instead of asserting the file is still reachable.
 *
 */
export function createRestoredAttachment(
  persisted: PersistedAttachment,
): ChatAttachment {
  const internalAnnotation$ = state<ImageAnnotation | null>(
    persisted.annotation ?? null,
  );
  const annotation$ = computed((get) => {
    return get(internalAnnotation$);
  });
  const setAnnotation$ = command(
    ({ set }, annotation: ImageAnnotation | null): void => {
      set(internalAnnotation$, annotation);
    },
  );
  const persistedInfo: FileInfo = {
    id: persisted.id,
    url: persisted.url,
    contentType: persisted.contentType,
  };
  const fileInfo$ = computed(async (get): Promise<FileInfo | null> => {
    const signal = get(rootSignal$);
    const client = get(apiClient$)(webFilesContract);
    const resolved = await accept(
      client.fileUrl({
        query: { file_id: persisted.id },
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
    );
    return resolved.status === 404 ? null : persistedInfo;
  });

  const cancel$ = command(() => {
    // no-op: already uploaded, nothing to cancel
  });
  // upload$ accepts a signal parameter to match the ChatAttachment interface.
  // The file is already uploaded, so this is a no-op.
  const upload$ = command((_visitor, _signal: AbortSignal): Promise<void> => {
    return Promise.resolve();
  });

  return {
    filename: persisted.filename,
    contentType: persisted.contentType,
    size: persisted.size,
    imageLoad: createImageLoadSignals(),
    fileInfo$,
    uploadPending$: noUploadPending$,
    cancel$,
    upload$,
    annotation$,
    setAnnotation$,
  };
}

/** Fixed id so repeated restores replace the toast instead of stacking. */
const UNAVAILABLE_ATTACHMENT_TOAST_ID = "chat-attachment-unavailable";

/**
 * Tells the user which attachments no longer resolve and returns the message so
 * a caller can reuse it to abort. Re-uploading is the only fix, so the copy
 * says that rather than offering a retry.
 */
function reportUnavailableAttachments(filenames: readonly string[]): string {
  const message =
    filenames.length === 1
      ? i18n.t(
          ($) => {
            return $.chat.attachments.unavailable;
          },
          { filename: filenames[0] },
        )
      : i18n.t(
          ($) => {
            return $.chat.attachments.unavailableCount;
          },
          { count: filenames.length },
        );
  toast.warning(message, { id: UNAVAILABLE_ATTACHMENT_TOAST_ID });
  return message;
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

/**
 * Drops restored attachments whose artifact no longer resolves for this
 * account. Leaving them in place strands the composer: the chip waits on a file
 * it can never load and every send is rejected, so removing them and saying so
 * is the only state the user can act on.
 */
function createPruneUnavailableAttachments(
  internalAttachments$: State<ChatAttachment[]>,
): Command<Promise<boolean>, [readonly ChatAttachment[], AbortSignal]> {
  return command(
    async (
      { get, set },
      candidates: readonly ChatAttachment[],
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (candidates.length === 0) {
        return false;
      }
      const infos = await Promise.all(
        candidates.map((attachment) => {
          return get(attachment.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const currentAttachments = get(internalAttachments$);
      const unavailable = candidates.filter((attachment, index) => {
        return infos[index] === null && currentAttachments.includes(attachment);
      });
      if (unavailable.length === 0) {
        return false;
      }
      set(internalAttachments$, (prev) => {
        return prev.filter((attachment) => {
          return !unavailable.includes(attachment);
        });
      });
      reportUnavailableAttachments(
        unavailable.map((attachment) => {
          return attachment.filename;
        }),
      );
      return true;
    },
  );
}

function createDraftLifecycleSignals({
  draftInput,
  draftDocument,
  internalGenerationTemplate$,
  internalAttachments$,
  internalDragOver$,
  pruneUnavailableAttachments$,
}: {
  draftInput: ReturnType<typeof createDraftInputSignals>;
  draftDocument: ReturnType<typeof createDraftDocumentSignals>;
  internalGenerationTemplate$: State<GenerationTemplateRequest | undefined>;
  internalAttachments$: State<ChatAttachment[]>;
  internalDragOver$: State<boolean>;
  pruneUnavailableAttachments$: Command<
    Promise<boolean>,
    [readonly ChatAttachment[], AbortSignal]
  >;
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

  const seed$ = command(
    async (
      { set },
      value: DraftSeed,
      signal: AbortSignal,
    ): Promise<boolean> => {
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
      return await set(pruneUnavailableAttachments$, value.attachments, signal);
    },
  );

  return { clear$, seed$ };
}

export function createDraftSignals(): DraftSignals {
  const draftInput = createDraftInputSignals();
  const draftDocument = createDraftDocumentSignals();
  const internalGenerationTemplate$ = state<
    GenerationTemplateRequest | undefined
  >(undefined);
  const internalAttachments$ = state<ChatAttachment[]>([]);
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

  const attachmentUploadsReady$ = computed((get): boolean => {
    return get(internalAttachments$).every((attachment) => {
      return !get(attachment.uploadPending$);
    });
  });

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

  const pruneUnavailableAttachments$ =
    createPruneUnavailableAttachments(internalAttachments$);

  const restoreAttachments$ = command(
    async (
      { set },
      persisted: PersistedAttachment[],
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (persisted.length === 0) {
        return false;
      }
      const restored = persisted.map(createRestoredAttachment);
      set(internalAttachments$, (prev) => {
        return [...prev, ...restored];
      });
      return await set(pruneUnavailableAttachments$, restored, signal);
    },
  );

  const removeAttachment$ = command(({ set }, attachment: ChatAttachment) => {
    set(attachment.cancel$);
    set(internalAttachments$, (prev) => {
      return prev.filter((a) => {
        return a !== attachment;
      });
    });
  });

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
    pruneUnavailableAttachments$,
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
