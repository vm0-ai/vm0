import { command, computed, state } from "ccstate";
import { artifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import { zeroImageIoInterpretMarksContract } from "@vm0/api-contracts/contracts/zero-image-io-interpret-marks";
import {
  zeroBuiltInGenerationContract,
  type ZeroBuiltInGenerationResponse,
} from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import {
  createDeferredPromise,
  onRef,
  setLoop,
  tapError,
  withCleanup,
} from "../utils.ts";
import { publicAttachmentUrl } from "../../views/zero-page/zero-attachment-url.ts";
import {
  ARTIFACT_FULLSCREEN_PARAM,
  ARTIFACT_HTML_EDIT_PARAM,
  ARTIFACT_IMAGE_EDIT_PARAM,
  ARTIFACT_INBOX_QUERY_PARAM,
  ARTIFACT_QUERY_PARAM,
  clearChatAutomationSidebarParams,
  clearMailDraftSidebarParams,
} from "./right-sidebar-search-params.ts";
import {
  addEditableImageCanvasItem$,
  clearEditableImageCanvasTransientState$,
  clearEditableImageCanvasRegionSelection$,
  createInitialEditableImageCanvasItem,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  editableImageArtifactCanvasKey,
  editableImageCanvasItemsByKey$,
  editableImageCanvasMutationRevisionsByKey$,
  type EditableImageCanvasItem,
  type EditableImageCanvasSnapshot,
  hydrateEditableImageCanvas$,
  hydrateEditableImageCanvasSnapshot$,
  insertEditableImageCanvasItem$,
  removeEditableImageCanvasRegionComments$,
  saveEditableImageCanvasSnapshot$,
} from "./zero-editable-image-canvas.ts";

export type ImageEditOperation =
  | "removeBackground"
  | "editRegion"
  | "enhance"
  | "styleTransfer";

export type ImageEditRegion = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type ImageEditImageSize = {
  height: number;
  width: number;
};

export type ImageEditRegionComment = {
  id: string;
  instruction: string;
  region: ImageEditRegion;
};

const IMAGE_EDIT_MODEL_BY_OPERATION = {
  removeBackground: "birefnet",
  enhance: "clarity-upscaler",
  editRegion: "nano-banana-2",
  styleTransfer: "nano-banana-2",
} as const satisfies Record<ImageEditOperation, string>;
// Region editing runs in two steps. First a multimodal model interprets a copy
// of the source image with numbered marks drawn on each selected region,
// turning each mark + user comment into a disambiguated, self-contained edit
// instruction. Then the image editor applies all of those instructions to the
// clean source image in a single pass. The marked image is downscaled to keep
// the understanding request small.
const MARKED_IMAGE_MAX_EDGE = 1280;
// The marked image only needs to be legible enough for the model to read the
// numbered outlines; JPEG keeps the inline data URI small enough to stay well
// under request-body limits (a lossless PNG of a photo can be several MB).
const MARKED_IMAGE_MIME = "image/jpeg";
const MARKED_IMAGE_QUALITY = 0.85;
const REGION_MARK_STROKE = "#ff2d95";
const REGION_MARK_LINE_WIDTH = 4;
// Cap the interpret and generation-start requests so a hung backend can't leave
// the edit lock (internalImageEditUploading$) stuck true until a page reload.
const IMAGE_EDIT_REQUEST_TIMEOUT_MS = 45_000;
const IMAGE_EDIT_SNAPSHOT_PERSIST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;
// Bound the region source-image load so a stalled request can't hang the run
// (and its "Working"/Send-disabled flag) forever; the poll path is likewise
// time-boxed via POLL_TIMEOUT_MS.
const IMAGE_LOAD_TIMEOUT_MS = 30_000;

const IMAGE_EDIT_LOADING_TOAST = {
  removeBackground: "Removing background...",
  editRegion: "Editing selected area...",
  enhance: "Enhancing image...",
  styleTransfer: "Applying style transfer...",
} as const satisfies Record<ImageEditOperation, string>;

const IMAGE_UPLOAD_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> =
  {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
const SUPPORTED_IMAGE_UPLOAD_CONTENT_TYPES = [
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const internalImageEditUploading$ = state(false);
const internalPersistedImageCanvasSnapshotPresentByKey$ = state<
  Record<string, boolean>
>({});

export const artifactImageEditMode$ = computed((get) => {
  return get(searchParams$).get(ARTIFACT_IMAGE_EDIT_PARAM) === "1";
});

export const imageEditUploading$ = computed((get) => {
  return get(internalImageEditUploading$);
});

type OpenArtifactImageEditArgs =
  | string
  | {
      readonly fullscreen: boolean;
      readonly url: string;
    };

type RunImageEditArgs = {
  artifactUrl: string;
  canvasKey: string;
  canvasSrc: string;
  operation: ImageEditOperation;
  regionComments?: readonly ImageEditRegionComment[];
  sourceImageNaturalHeight: number;
  sourceImageNaturalWidth: number;
  sourceItemId: string;
  stylePrompt?: string;
  url: string;
};

type UploadEditableImageCanvasImageArgs = {
  artifactUrl: string;
  canvasKey: string;
  canvasSrc: string;
};

export const openArtifactImageEdit$ = command(
  ({ get, set }, value: OpenArtifactImageEditArgs) => {
    const args =
      typeof value === "string" ? { fullscreen: false, url: value } : value;
    const params = new URLSearchParams(get(searchParams$));
    params.set(ARTIFACT_QUERY_PARAM, args.url);
    params.set(ARTIFACT_IMAGE_EDIT_PARAM, "1");
    params.delete(ARTIFACT_INBOX_QUERY_PARAM);
    params.delete(ARTIFACT_HTML_EDIT_PARAM);
    if (args.fullscreen) {
      params.set(ARTIFACT_FULLSCREEN_PARAM, "1");
    } else {
      params.delete(ARTIFACT_FULLSCREEN_PARAM);
    }
    clearChatAutomationSidebarParams(params);
    clearMailDraftSidebarParams(params);
    set(
      hydrateEditableImageCanvas$,
      editableImageArtifactCanvasKey(args.url),
      publicAttachmentUrl(args.url),
    );
    set(updateSearchParams$, params);
  },
);

export const closeArtifactImageEdit$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  const url = params.get(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_IMAGE_EDIT_PARAM);
  if (url) {
    const canvasKey = editableImageArtifactCanvasKey(url);
    const canvasSrc = publicAttachmentUrl(url);
    set(saveEditableImageCanvasSnapshot$, canvasKey, canvasSrc);
    set(clearEditableImageCanvasTransientState$, canvasKey);
  }
  set(replaceSearchParams$, params);
});

export const loadPersistedEditableImageCanvasSnapshot$ = command(
  async (
    { get, set },
    args: { canvasSrc: string; key: string; url: string },
    signal: AbortSignal,
  ) => {
    const initialMutationRevision =
      get(editableImageCanvasMutationRevisionsByKey$)[args.key] ?? 0;
    const client = get(zeroClient$)(artifactsContract, { apiBase: "api" });
    const loaded = await accept(
      client.getImageEditSnapshot({
        query: { url: args.url },
        fetchOptions: { signal },
      }),
      [200, 404],
      { toast: false },
    );
    signal.throwIfAborted();
    if (loaded.status === 404 || loaded.body.snapshot === null) {
      set(internalPersistedImageCanvasSnapshotPresentByKey$, (current) => {
        return { ...current, [args.key]: false };
      });
      return;
    }
    set(internalPersistedImageCanvasSnapshotPresentByKey$, (current) => {
      return { ...current, [args.key]: true };
    });
    if (
      initialMutationRevision !== 0 ||
      (get(editableImageCanvasMutationRevisionsByKey$)[args.key] ?? 0) !==
        initialMutationRevision
    ) {
      return;
    }

    set(
      hydrateEditableImageCanvasSnapshot$,
      args.key,
      args.canvasSrc,
      loaded.body.snapshot.snapshot,
    );
  },
);

function shouldDeletePersistedImageCanvasSnapshot(
  items: readonly EditableImageCanvasItem[],
  canvasSrc: string,
): boolean {
  if (items.length === 0) {
    return true;
  }

  const [onlyItem] = items;
  if (
    items.length !== 1 ||
    !onlyItem ||
    onlyItem.src !== canvasSrc ||
    onlyItem.zIndex !== 1
  ) {
    return false;
  }

  return (
    onlyItem.x ===
      Math.round((DEFAULT_CANVAS_WIDTH - onlyItem.displayWidth) / 2) &&
    onlyItem.y ===
      Math.round((DEFAULT_CANVAS_HEIGHT - onlyItem.displayHeight) / 2)
  );
}

export const persistEditableImageCanvasSnapshot$ = command(
  async (
    { get, set },
    args: { canvasSrc: string; key: string; url: string },
    signal: AbortSignal,
  ) => {
    const items = get(editableImageCanvasItemsByKey$)[args.key] ?? [
      createInitialEditableImageCanvasItem(args.canvasSrc),
    ];
    const snapshot: EditableImageCanvasSnapshot = set(
      saveEditableImageCanvasSnapshot$,
      args.key,
      args.canvasSrc,
    );
    const client = get(zeroClient$)(artifactsContract, { apiBase: "api" });
    if (shouldDeletePersistedImageCanvasSnapshot(items, args.canvasSrc)) {
      if (!get(internalPersistedImageCanvasSnapshotPresentByKey$)[args.key]) {
        return;
      }

      await accept(
        client.deleteImageEditSnapshot({
          query: { url: args.url },
          fetchOptions: { signal },
        }),
        [204, 404],
        { toast: false },
      );
      signal.throwIfAborted();
      set(internalPersistedImageCanvasSnapshotPresentByKey$, (current) => {
        return { ...current, [args.key]: false };
      });
      return;
    }

    const saved = await accept(
      client.upsertImageEditSnapshot({
        body: {
          snapshot: {
            items: snapshot.items.map((item) => {
              return { ...item };
            }),
            version: snapshot.version,
          },
          url: args.url,
        },
        fetchOptions: { signal },
      }),
      [200, 204, 404],
      { toast: false },
    );
    signal.throwIfAborted();
    if (saved.status === 200) {
      set(internalPersistedImageCanvasSnapshotPresentByKey$, (current) => {
        return { ...current, [args.key]: true };
      });
    } else if (saved.status === 204) {
      set(internalPersistedImageCanvasSnapshotPresentByKey$, (current) => {
        return { ...current, [args.key]: false };
      });
    }
  },
);

function imageEditSnapshotControllerArgs(el: HTMLDivElement): {
  canvasSrc: string;
  key: string;
  url: string;
} | null {
  const canvasSrc = el.dataset.imageEditSnapshotCanvasSrc;
  const key = el.dataset.imageEditSnapshotCanvasKey;
  const url = el.dataset.imageEditSnapshotUrl;
  return canvasSrc && key && url ? { canvasSrc, key, url } : null;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  signal.addEventListener(
    "abort",
    () => {
      resolve();
    },
    { once: true },
  );
  await promise;
}

const persistImageEditSnapshotOnAbort$ = command(
  async (
    { set },
    args: { canvasSrc: string; key: string; url: string },
    signal: AbortSignal,
  ) => {
    await waitForAbort(signal);
    await set(
      persistEditableImageCanvasSnapshot$,
      args,
      AbortSignal.timeout(IMAGE_EDIT_SNAPSHOT_PERSIST_TIMEOUT_MS),
    );
  },
);

export const setImageEditSnapshotControllerRef$ = onRef(
  command(async ({ set }, el: HTMLDivElement, signal: AbortSignal) => {
    const args = imageEditSnapshotControllerArgs(el);
    if (!args) {
      return;
    }
    const [loadResult, persistResult] = await Promise.allSettled([
      set(loadPersistedEditableImageCanvasSnapshot$, args, signal),
      set(persistImageEditSnapshotOnAbort$, args, signal),
    ]);
    signal.throwIfAborted();
    if (persistResult.status === "rejected") {
      throw persistResult.reason;
    }
    if (loadResult.status === "rejected") {
      throw loadResult.reason;
    }
  }),
);

function readResultImageUrl(
  result: Record<string, unknown> | undefined,
): string {
  const url = result?.url;
  if (typeof url !== "string" || !url) {
    throw new Error("Image edit result is missing a url");
  }
  return url;
}

function styleTransferPrompt(stylePrompt: string | undefined): string {
  const style = stylePrompt?.trim();
  return [
    "Apply a visual style transfer to this image.",
    "Preserve the main subject, composition, proportions and important details.",
    "Do not add extra text, logos, watermarks or unrelated objects.",
    style
      ? `Style direction: ${style}`
      : "Style direction: refined editorial artwork with natural lighting.",
  ].join(" ");
}

function formatRegionLocation(
  region: ImageEditRegion,
  imageSize: ImageEditImageSize,
): string {
  const width = Math.max(1, imageSize.width);
  const height = Math.max(1, imageSize.height);
  const centerX = ((region.x + region.width / 2) / width) * 100;
  const centerY = ((region.y + region.height / 2) / height) * 100;
  const horizontal = centerX < 34 ? "left" : centerX < 67 ? "center" : "right";
  const vertical = centerY < 34 ? "top" : centerY < 67 ? "middle" : "bottom";
  const zone =
    horizontal === "center" && vertical === "middle"
      ? "center"
      : `${vertical}-${horizontal}`;
  return `That region sits in the ${zone} area of the first image, centered about ${Math.round(centerX)}% from the left and ${Math.round(centerY)}% from the top.`;
}

type ResolvedRegionEdit = {
  edit: string;
  target: string;
};

function editRegionPrompt(edits: readonly ResolvedRegionEdit[]): string {
  const lines = edits.map(({ edit, target }, index) => {
    const change = edit.trim() || "modify this area naturally";
    const where = target.trim();
    return where
      ? `- Edit ${index + 1}: in ${where}, ${change}.`
      : `- Edit ${index + 1}: ${change}.`;
  });
  return [
    "Apply the following edits to this image, each only in the area it names:",
    ...lines,
    "Make each change only in its own area; keep everything else in the image exactly the same and blend each edit naturally with its surroundings.",
    "Do not add text, logos, watermarks or unrelated objects unless an edit asks for it.",
    "Output only the edited image.",
  ].join(" ");
}

function imageEditPrompt(args: {
  operation: ImageEditOperation;
  regionEdits?: readonly ResolvedRegionEdit[];
  stylePrompt?: string;
}): string | undefined {
  switch (args.operation) {
    case "removeBackground":
    case "enhance": {
      return undefined;
    }
    case "editRegion": {
      return editRegionPrompt(args.regionEdits ?? []);
    }
    case "styleTransfer": {
      return styleTransferPrompt(args.stylePrompt);
    }
  }
}

function inferImageUploadContentType(file: File): string | null {
  const explicitType = file.type.split(";")[0]?.trim().toLowerCase();
  if (
    SUPPORTED_IMAGE_UPLOAD_CONTENT_TYPES.includes(
      explicitType as (typeof SUPPORTED_IMAGE_UPLOAD_CONTENT_TYPES)[number],
    )
  ) {
    return explicitType;
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension
    ? (IMAGE_UPLOAD_CONTENT_TYPE_BY_EXTENSION[extension] ?? null)
    : null;
}

async function uploadImageFile({
  contentType,
  createClient,
  file,
  signal,
}: {
  contentType: string;
  createClient: ZeroClientFactory;
  file: File;
  signal: AbortSignal;
}) {
  const client = createClient(zeroUploadsContract);
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

  const putResponse = await fetch(prepared.body.uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "content-type": prepared.body.contentType },
    signal,
  });
  signal.throwIfAborted();

  if (!putResponse.ok) {
    throw new Error(
      `storage returned ${putResponse.status} ${putResponse.statusText}`,
    );
  }

  const completed = await accept(
    client.complete({
      body: {
        id: prepared.body.id,
        contentType: prepared.body.contentType,
      },
      fetchOptions: { signal },
    }),
    [200],
  );
  signal.throwIfAborted();

  return completed.body.url;
}

function clampCropCoordinate(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

// Load under a distinct query key so the CORS request doesn't reuse the
// non-CORS response the displayed <img> cached without an
// Access-Control-Allow-Origin header (which would taint the canvas). Set the
// param through URL so it lands in the query string even when the URL carries a
// #fragment (plain concat would push it inside the fragment and be ignored).
function editCropCacheBustUrl(url: string): string {
  if (!URL.canParse(url)) {
    return url.includes("?") ? `${url}&editcrop=1` : `${url}?editcrop=1`;
  }
  const parsed = new URL(url);
  parsed.searchParams.set("editcrop", "1");
  return parsed.toString();
}

async function loadCrossOriginImage(
  url: string,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  const loadSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(IMAGE_LOAD_TIMEOUT_MS),
  ]);
  const deferred = createDeferredPromise<HTMLImageElement>(loadSignal);
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.addEventListener("load", () => {
    if (!deferred.settled()) {
      deferred.resolve(image);
    }
  });
  image.addEventListener("error", () => {
    if (!deferred.settled()) {
      deferred.reject(new Error("Couldn't load the image to edit"));
    }
  });
  image.src = editCropCacheBustUrl(url);
  const loaded = await deferred.promise;
  signal.throwIfAborted();
  return loaded;
}

// Draw a downscaled copy of the source image with a numbered outline over each
// selected region. The numbers (1-based, matching each comment's position) are
// what the understanding model uses to map an instruction back to an area.
function createMarkedImageDataUri(
  image: HTMLImageElement,
  regionComments: readonly ImageEditRegionComment[],
  imageSize: ImageEditImageSize,
): string {
  const scale = Math.min(
    1,
    MARKED_IMAGE_MAX_EDGE / Math.max(imageSize.width, imageSize.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(imageSize.width * scale));
  canvas.height = Math.max(1, Math.round(imageSize.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Couldn't create the marked image");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  context.lineWidth = REGION_MARK_LINE_WIDTH;
  context.font = "bold 28px sans-serif";
  context.textBaseline = "top";
  for (const [index, comment] of regionComments.entries()) {
    const x = clampCropCoordinate(comment.region.x * scale, canvas.width);
    const y = clampCropCoordinate(comment.region.y * scale, canvas.height);
    const width = Math.max(1, comment.region.width * scale);
    const height = Math.max(1, comment.region.height * scale);
    context.strokeStyle = REGION_MARK_STROKE;
    context.strokeRect(x, y, width, height);

    const label = String(index + 1);
    const badgeWidth = context.measureText(label).width + 12;
    const badgeHeight = 30;
    const badgeX = clampCropCoordinate(x, canvas.width - badgeWidth);
    const badgeY = clampCropCoordinate(y, canvas.height - badgeHeight);
    context.fillStyle = REGION_MARK_STROKE;
    context.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);
    context.fillStyle = "#ffffff";
    context.fillText(label, badgeX + 6, badgeY + 4);
  }
  return canvas.toDataURL(MARKED_IMAGE_MIME, MARKED_IMAGE_QUALITY);
}

// Abort a request when the parent signal fires OR the request timeout elapses,
// so a stalled backend can't hang the run forever.
function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(IMAGE_EDIT_REQUEST_TIMEOUT_MS),
  ]);
}

async function interpretRegionMarks({
  createClient,
  markedImageDataUri,
  regionComments,
  imageSize,
  signal,
}: {
  createClient: ZeroClientFactory;
  markedImageDataUri: string;
  regionComments: readonly ImageEditRegionComment[];
  imageSize: ImageEditImageSize;
  signal: AbortSignal;
}): Promise<Map<string, ResolvedRegionEdit>> {
  const client = createClient(zeroImageIoInterpretMarksContract, {
    apiBase: "api",
  });
  const interpreted = await accept(
    client.post({
      body: {
        imageUrl: markedImageDataUri,
        regions: regionComments.map((comment, index) => {
          return {
            id: comment.id,
            mark: index + 1,
            instruction: comment.instruction,
            location: formatRegionLocation(comment.region, imageSize),
          };
        }),
      },
      fetchOptions: { signal: requestSignal(signal) },
    }),
    [200],
    // run() surfaces a single generic toast via tapError; suppress accept's own
    // toast so an interpret failure isn't reported twice.
    { toast: false },
  );
  signal.throwIfAborted();

  const byId = new Map<string, ResolvedRegionEdit>();
  for (const region of interpreted.body.regions) {
    byId.set(region.id, { edit: region.edit, target: region.target });
  }
  return byId;
}

function readPollResultUrl(
  generation: ZeroBuiltInGenerationResponse,
): string | null | undefined {
  if (generation.status === "completed") {
    return readResultImageUrl(generation.result);
  }
  if (generation.status === "failed") {
    return null;
  }
  return undefined;
}

async function startImageEditGeneration({
  createClient,
  operation,
  regionEdits,
  signal,
  sourceUrl,
  stylePrompt,
}: {
  createClient: ZeroClientFactory;
  operation: ImageEditOperation;
  regionEdits?: readonly ResolvedRegionEdit[];
  signal: AbortSignal;
  sourceUrl: string;
  stylePrompt?: string;
}) {
  const generateClient = createClient(zeroImageIoGenerateContract, {
    apiBase: "api",
  });
  const regionEdit = operation === "editRegion";
  const accepted = await accept(
    generateClient.post({
      body: {
        model: IMAGE_EDIT_MODEL_BY_OPERATION[operation],
        outputFormat: regionEdit ? "png" : undefined,
        prompt: imageEditPrompt({
          operation,
          regionEdits,
          stylePrompt,
        }),
        size: regionEdit ? "auto" : undefined,
        sourceImageUrls: [sourceUrl],
      },
      fetchOptions: { signal: requestSignal(signal) },
    }),
    [202],
  );
  signal.throwIfAborted();
  return accepted.body.generationId;
}

async function pollImageEditResultUrl({
  createClient,
  generationId,
  signal,
}: {
  createClient: ZeroClientFactory;
  generationId: string;
  signal: AbortSignal;
}) {
  const generationClient = createClient(zeroBuiltInGenerationContract, {
    apiBase: "api",
  });
  const expiresAt = now() + POLL_TIMEOUT_MS;
  let resultUrl: string | null = null;

  await setLoop(
    async (loopSignal) => {
      if (now() >= expiresAt) {
        return true;
      }

      const polled = await accept(
        generationClient.get({
          params: { generationId },
          fetchOptions: { signal: loopSignal },
        }),
        [200],
      );
      loopSignal.throwIfAborted();

      const polledResultUrl = readPollResultUrl(polled.body);
      if (polledResultUrl !== undefined) {
        resultUrl = polledResultUrl;
        return true;
      }

      return now() >= expiresAt;
    },
    POLL_INTERVAL_MS,
    signal,
  );

  return resultUrl;
}

async function waitForImageEditResultUrl({
  createClient,
  generationId,
  signal,
}: {
  createClient: ZeroClientFactory;
  generationId: string;
  signal: AbortSignal;
}) {
  return await pollImageEditResultUrl({
    createClient,
    generationId,
    signal,
  });
}

const persistRunImageEditSnapshot$ = command(
  async ({ set }, args: RunImageEditArgs, signal: AbortSignal) => {
    await tapError(
      set(
        persistEditableImageCanvasSnapshot$,
        {
          canvasSrc: args.canvasSrc,
          key: args.canvasKey,
          url: args.artifactUrl,
        },
        signal,
      ),
      () => {},
    );
  },
);

export const runImageEdit$ = command(
  async ({ get, set }, args: RunImageEditArgs, parentSignal: AbortSignal) => {
    if (get(internalImageEditUploading$)) {
      toast.info("An edit is already in progress");
      return;
    }

    const signal = parentSignal;
    const editRegion = args.operation === "editRegion";
    const toastId = toast.loading(IMAGE_EDIT_LOADING_TOAST[args.operation]);
    set(internalImageEditUploading$, true);

    const run = async () => {
      const createClient = get(zeroClient$);
      const imageSize = {
        height: args.sourceImageNaturalHeight,
        width: args.sourceImageNaturalWidth,
      };
      const regionComments = editRegion ? (args.regionComments ?? []) : [];

      const runSingleGeneration = async (
        sourceUrl: string,
        regionEdits: readonly ResolvedRegionEdit[] | undefined,
      ): Promise<string | null> => {
        const generationId = await startImageEditGeneration({
          createClient,
          operation: args.operation,
          regionEdits,
          signal,
          sourceUrl,
          stylePrompt: args.stylePrompt,
        });
        return await waitForImageEditResultUrl({
          createClient,
          generationId,
          signal,
        });
      };

      if (editRegion && regionComments.length > 0) {
        // Step 1: a multimodal model reads a marked copy of the image and turns
        // each numbered region + comment into a disambiguated edit instruction.
        // Step 2: apply all of those instructions to the clean source image in a
        // single generation.
        const sourceImage = await loadCrossOriginImage(
          publicAttachmentUrl(args.url),
          signal,
        );
        const markedImageDataUri = createMarkedImageDataUri(
          sourceImage,
          regionComments,
          imageSize,
        );
        const resolved = await interpretRegionMarks({
          createClient,
          markedImageDataUri,
          regionComments,
          imageSize,
          signal,
        });
        const regionEdits = regionComments.map((comment) => {
          return (
            resolved.get(comment.id) ?? {
              edit: comment.instruction,
              target: "",
            }
          );
        });

        const resultUrl = await runSingleGeneration(
          publicAttachmentUrl(args.url),
          regionEdits,
        );

        // Always leave region-selection mode; the "Select area" toggle and draft
        // must not stay stuck on after a run, whether it applied or not.
        set(clearEditableImageCanvasRegionSelection$, args.canvasKey);

        if (resultUrl === null) {
          toast.dismiss(toastId);
          toast.error("Couldn't edit the image, try again");
          return;
        }

        set(addEditableImageCanvasItem$, {
          canvasSrc: args.canvasSrc,
          key: args.canvasKey,
          sourceItemId: args.sourceItemId,
          src: resultUrl,
        });
        set(removeEditableImageCanvasRegionComments$, {
          commentIds: regionComments.map((comment) => {
            return comment.id;
          }),
          key: args.canvasKey,
        });
        await set(persistRunImageEditSnapshot$, args, signal);
        // A single generation applies all comments at once and the model gives
        // no per-region confirmation, so it can silently skip one when several
        // are batched. Tell the user to verify rather than assume every edit
        // landed.
        if (regionComments.length > 1) {
          toast.info(
            `Applied ${regionComments.length} edits — check the result and re-add any that were missed`,
          );
        }
        return;
      }

      const resultUrl = await runSingleGeneration(
        publicAttachmentUrl(args.url),
        undefined,
      );
      if (resultUrl === null) {
        toast.dismiss(toastId);
        toast.error("Couldn't edit the image, try again");
        return;
      }
      set(addEditableImageCanvasItem$, {
        canvasSrc: args.canvasSrc,
        key: args.canvasKey,
        sourceItemId: args.sourceItemId,
        src: resultUrl,
      });
      await set(persistRunImageEditSnapshot$, args, signal);
    };

    await withCleanup(
      tapError(run(), () => {
        toast.error("Couldn't edit the image, try again");
        // A thrown run (e.g. the source-image load timed out mid-sequence) also
        // has to release the region toggle so it isn't left stuck on.
        if (editRegion) {
          set(clearEditableImageCanvasRegionSelection$, args.canvasKey);
        }
      }),
      () => {
        toast.dismiss(toastId);
        set(internalImageEditUploading$, false);
      },
    );
  },
);

export const uploadEditableImageCanvasImage$ = command(
  async (
    { get, set },
    args: UploadEditableImageCanvasImageArgs,
    files: readonly File[],
    parentSignal: AbortSignal,
  ) => {
    if (get(internalImageEditUploading$)) {
      return;
    }

    if (files.length === 0) {
      return;
    }

    const uploads = files.flatMap((file) => {
      const contentType = inferImageUploadContentType(file);
      if (!contentType) {
        return [];
      }
      return [
        {
          contentType,
          file,
        },
      ];
    });
    if (uploads.length !== files.length) {
      toast.error("Choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image");
      return;
    }

    const signal = parentSignal;
    set(internalImageEditUploading$, true);

    const run = async () => {
      const createClient = get(zeroClient$);
      for (const upload of uploads) {
        const url = await uploadImageFile({
          contentType: upload.contentType,
          createClient,
          file: upload.file,
          signal,
        });
        set(insertEditableImageCanvasItem$, {
          canvasSrc: args.canvasSrc,
          key: args.canvasKey,
          src: url,
        });
      }
      await tapError(
        set(
          persistEditableImageCanvasSnapshot$,
          {
            canvasSrc: args.canvasSrc,
            key: args.canvasKey,
            url: args.artifactUrl,
          },
          signal,
        ),
        () => {},
      );
      toast.success(
        uploads.length === 1 ? "Image uploaded" : "Images uploaded",
      );
    };

    await withCleanup(
      tapError(run(), () => {
        toast.error("Couldn't upload image, try again");
      }),
      () => {
        set(internalImageEditUploading$, false);
      },
    );
  },
);
