import { command, computed, state } from "ccstate";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import {
  zeroBuiltInGenerationContract,
  type ZeroBuiltInGenerationResponse,
} from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { toast } from "@vm0/ui/components/ui/sonner";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { setLoop, tapError, withCleanup } from "../utils.ts";
import { publicAttachmentUrl } from "../../views/zero-page/zero-attachment-url.ts";
import {
  ARTIFACT_FULLSCREEN_PARAM,
  ARTIFACT_HTML_EDIT_PARAM,
  ARTIFACT_IMAGE_EDIT_PARAM,
  ARTIFACT_INBOX_QUERY_PARAM,
  ARTIFACT_QUERY_PARAM,
  clearChatAutomationSidebarParams,
} from "./right-sidebar-search-params.ts";
import {
  addEditableImageCanvasItem$,
  editableImageArtifactCanvasKey,
  insertEditableImageCanvasItem$,
  resetEditableImageCanvas$,
} from "./zero-editable-image-canvas.ts";

export type ImageEditOperation =
  | "removeBackground"
  | "enhance"
  | "styleTransfer";

const IMAGE_EDIT_MODEL = "nano-banana-2";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

const IMAGE_EDIT_PROMPTS = {
  removeBackground:
    "Remove the background completely. Keep only the main subject on a plain solid white background. Do not alter the subject.",
  enhance:
    "Enhance this image to high definition. Increase sharpness, clarity and fine detail while faithfully preserving the original content, composition and colors.",
} as const satisfies Record<
  Exclude<ImageEditOperation, "styleTransfer">,
  string
>;

const IMAGE_EDIT_LOADING_TOAST = {
  removeBackground: "Removing background...",
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
  canvasKey: string;
  canvasSrc: string;
  operation: ImageEditOperation;
  sourceItemId: string;
  stylePrompt?: string;
  url: string;
};

type UploadEditableImageCanvasImageArgs = {
  canvasKey: string;
  canvasSrc: string;
};

type ImportEditableImageCanvasImageUrlArgs = UploadEditableImageCanvasImageArgs;

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
    set(
      resetEditableImageCanvas$,
      editableImageArtifactCanvasKey(args.url),
      publicAttachmentUrl(args.url),
    );
    set(updateSearchParams$, params);
  },
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

function imageEditPrompt(args: {
  operation: ImageEditOperation;
  stylePrompt?: string;
}): string {
  switch (args.operation) {
    case "removeBackground": {
      return IMAGE_EDIT_PROMPTS.removeBackground;
    }
    case "enhance": {
      return IMAGE_EDIT_PROMPTS.enhance;
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

async function importImageUrl({
  createClient,
  signal,
  url,
}: {
  createClient: ZeroClientFactory;
  signal: AbortSignal;
  url: string;
}) {
  const client = createClient(zeroUploadsContract);
  const imported = await accept(
    client.importImage({
      body: { url },
      fetchOptions: { signal },
    }),
    [200, 404],
    { toast: false },
  );
  signal.throwIfAborted();

  if (imported.status === 404) {
    return url;
  }

  return imported.body.url;
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
  signal,
  stylePrompt,
  url,
}: {
  createClient: ZeroClientFactory;
  operation: ImageEditOperation;
  signal: AbortSignal;
  stylePrompt?: string;
  url: string;
}) {
  const generateClient = createClient(zeroImageIoGenerateContract, {
    apiBase: "api",
  });
  const accepted = await accept(
    generateClient.post({
      body: {
        model: IMAGE_EDIT_MODEL,
        prompt: imageEditPrompt({ operation, stylePrompt }),
        sourceImageUrls: [publicAttachmentUrl(url)],
      },
      fetchOptions: { signal },
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

export const runImageEdit$ = command(
  async ({ get, set }, args: RunImageEditArgs, parentSignal: AbortSignal) => {
    const signal = parentSignal;
    const toastId = toast.loading(IMAGE_EDIT_LOADING_TOAST[args.operation]);

    const run = async () => {
      const createClient = get(zeroClient$);
      const generationId = await startImageEditGeneration({
        createClient,
        operation: args.operation,
        signal,
        stylePrompt: args.stylePrompt,
        url: args.url,
      });
      const resultUrl = await waitForImageEditResultUrl({
        createClient,
        generationId,
        signal,
      });
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
    };

    await withCleanup(run(), () => {
      toast.dismiss(toastId);
    });
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

export const importEditableImageCanvasImageUrl$ = command(
  async (
    { get, set },
    args: ImportEditableImageCanvasImageUrlArgs,
    url: string,
    parentSignal: AbortSignal,
  ) => {
    if (get(internalImageEditUploading$)) {
      return;
    }

    const signal = parentSignal;
    set(internalImageEditUploading$, true);

    const run = async () => {
      const importedUrl = await importImageUrl({
        createClient: get(zeroClient$),
        signal,
        url,
      });
      set(insertEditableImageCanvasItem$, {
        canvasSrc: args.canvasSrc,
        key: args.canvasKey,
        src: importedUrl,
      });
      toast.success("Image added");
    };

    await withCleanup(
      tapError(run(), () => {
        toast.error("Couldn't add image link, try again");
      }),
      () => {
        set(internalImageEditUploading$, false);
      },
    );
  },
);
