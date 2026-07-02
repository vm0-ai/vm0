import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import {
  zeroBuiltInGenerationContract,
  type ZeroBuiltInGenerationResponse,
} from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { toast } from "@vm0/ui/components/ui/sonner";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { resetSignal, withCleanup } from "../utils.ts";
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
  resetEditableImageCanvas$,
} from "./zero-editable-image-canvas.ts";

export type ImageEditOperation = "removeBackground" | "enhance";

const IMAGE_EDIT_MODEL = "nano-banana-2";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

const IMAGE_EDIT_PROMPTS = {
  removeBackground:
    "Remove the background completely. Keep only the main subject on a plain solid white background. Do not alter the subject.",
  enhance:
    "Enhance this image to high definition. Increase sharpness, clarity and fine detail while faithfully preserving the original content, composition and colors.",
} as const satisfies Record<ImageEditOperation, string>;

const IMAGE_EDIT_SUCCESS_TOAST = {
  removeBackground: "Background removed",
  enhance: "Image enhanced",
} as const satisfies Record<ImageEditOperation, string>;

const internalImageEditProcessing$ = state<null | ImageEditOperation>(null);
const resetImageEditSignal$ = resetSignal();

export const artifactImageEditMode$ = computed((get) => {
  return get(searchParams$).get(ARTIFACT_IMAGE_EDIT_PARAM) === "1";
});

export const imageEditProcessing$ = computed((get) => {
  return get(internalImageEditProcessing$);
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
  url: string;
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
  url,
}: {
  createClient: ZeroClientFactory;
  operation: ImageEditOperation;
  signal: AbortSignal;
  url: string;
}) {
  const generateClient = createClient(zeroImageIoGenerateContract, {
    apiBase: "api",
  });
  const accepted = await accept(
    generateClient.post({
      body: {
        model: IMAGE_EDIT_MODEL,
        prompt: IMAGE_EDIT_PROMPTS[operation],
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
  timeoutSignal,
}: {
  createClient: ZeroClientFactory;
  generationId: string;
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
}) {
  const generationClient = createClient(zeroBuiltInGenerationContract, {
    apiBase: "api",
  });

  while (!timeoutSignal.aborted) {
    const polled = await accept(
      generationClient.get({
        params: { generationId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    const resultUrl = readPollResultUrl(polled.body);
    if (resultUrl !== undefined) {
      return resultUrl;
    }

    await delay(POLL_INTERVAL_MS, { signal });
  }

  return null;
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
  const timeoutSignal = AbortSignal.timeout(POLL_TIMEOUT_MS);

  return await pollImageEditResultUrl({
    createClient,
    generationId,
    signal,
    timeoutSignal,
  });
}

export const runImageEdit$ = command(
  async ({ get, set }, args: RunImageEditArgs, parentSignal: AbortSignal) => {
    if (get(internalImageEditProcessing$) !== null) {
      return;
    }

    const signal = set(resetImageEditSignal$, parentSignal);
    set(internalImageEditProcessing$, args.operation);

    const run = async () => {
      const createClient = get(zeroClient$);
      const generationId = await startImageEditGeneration({
        createClient,
        operation: args.operation,
        signal,
        url: args.url,
      });
      const resultUrl = await waitForImageEditResultUrl({
        createClient,
        generationId,
        signal,
      });
      if (resultUrl === null) {
        toast.error("Couldn't edit the image, try again");
        return;
      }
      set(addEditableImageCanvasItem$, {
        canvasSrc: args.canvasSrc,
        key: args.canvasKey,
        sourceItemId: args.sourceItemId,
        src: resultUrl,
      });
      toast.success(IMAGE_EDIT_SUCCESS_TOAST[args.operation]);
    };

    await withCleanup(run(), () => {
      set(internalImageEditProcessing$, null);
    });
  },
);
