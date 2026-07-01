import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  searchParams$,
  replaceSearchParams$,
  updateSearchParams$,
} from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
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

// ---------------------------------------------------------------------------
// Image editing — an EDIT mode of the artifact sidebar that shows a single
// image on a canvas with a floating toolbar. Each toolbar action calls the
// image-generation API with model `nano-banana-2` and a canned prompt, polls
// for completion, then swaps the shown image for the result while staying in
// edit mode. Gated by the `imageEditing` feature switch.
// ---------------------------------------------------------------------------

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

export const openArtifactImageEdit$ = command(({ get, set }, url: string) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set(ARTIFACT_QUERY_PARAM, url);
  params.set(ARTIFACT_IMAGE_EDIT_PARAM, "1");
  params.delete(ARTIFACT_INBOX_QUERY_PARAM);
  params.delete(ARTIFACT_HTML_EDIT_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  clearChatAutomationSidebarParams(params);
  set(updateSearchParams$, params);
});

export const closeArtifactImageEdit$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.delete(ARTIFACT_IMAGE_EDIT_PARAM);
  set(replaceSearchParams$, params);
});

function readResultImageUrl(
  result: Record<string, unknown> | undefined,
): string {
  const url = result?.url;
  if (typeof url !== "string" || !url) {
    throw new Error("Image edit result is missing a url");
  }
  return url;
}

export const runImageEdit$ = command(
  async (
    { get, set },
    args: { url: string; operation: ImageEditOperation },
    parentSignal: AbortSignal,
  ) => {
    if (get(internalImageEditProcessing$) !== null) {
      return;
    }

    const signal = set(resetImageEditSignal$, parentSignal);
    set(internalImageEditProcessing$, args.operation);

    const run = async () => {
      const absoluteUrl = publicAttachmentUrl(args.url);
      const generateClient = get(zeroClient$)(zeroImageIoGenerateContract, {
        apiBase: "api",
      });
      const accepted = await accept(
        generateClient.post({
          body: {
            model: IMAGE_EDIT_MODEL,
            prompt: IMAGE_EDIT_PROMPTS[args.operation],
            sourceImageUrls: [absoluteUrl],
          },
          fetchOptions: { signal },
        }),
        [202],
      );
      signal.throwIfAborted();

      const generationId = accepted.body.generationId;
      const generationClient = get(zeroClient$)(zeroBuiltInGenerationContract, {
        apiBase: "api",
      });

      const deadline = now() + POLL_TIMEOUT_MS;
      while (now() < deadline) {
        const polled = await accept(
          generationClient.get({
            params: { generationId },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();

        if (polled.body.status === "completed") {
          const resultUrl = readResultImageUrl(polled.body.result);
          const params = new URLSearchParams(get(searchParams$));
          params.set(ARTIFACT_QUERY_PARAM, resultUrl);
          params.set(ARTIFACT_IMAGE_EDIT_PARAM, "1");
          set(updateSearchParams$, params);
          toast.success(IMAGE_EDIT_SUCCESS_TOAST[args.operation]);
          return;
        }
        if (polled.body.status === "failed") {
          toast.error("Couldn't edit the image, try again");
          return;
        }

        await delay(POLL_INTERVAL_MS, { signal });
      }

      toast.error("Couldn't edit the image, try again");
    };

    await withCleanup(run(), () => {
      set(internalImageEditProcessing$, null);
    });
  },
);
