import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

export const INTRO_VIDEO_STYLE_FORMATS = ["16:9", "9:16"] as const;
type IntroVideoStyleFormat = (typeof INTRO_VIDEO_STYLE_FORMATS)[number];
function createIntroVideoStyleGallerySignals() {
  const internalFormat$ = state<IntroVideoStyleFormat>("16:9");
  const internalPreviewId$ = state<string | null>(null);
  return {
    format$: computed((get) => {
      return get(internalFormat$);
    }),
    setFormat$: command(({ set }, value: string) => {
      const format = INTRO_VIDEO_STYLE_FORMATS.find((candidate) => {
        return candidate === value;
      });
      if (format) {
        set(internalFormat$, format);
        set(internalPreviewId$, null);
      }
    }),
    previewId$: computed((get) => {
      return get(internalPreviewId$);
    }),
    previewStyle$: command(({ set }, id: string) => {
      set(internalPreviewId$, id);
    }),
    setGalleryRef$: onRef<HTMLDivElement>(
      command(({ set }, _node: HTMLDivElement, signal: AbortSignal) => {
        signal.addEventListener(
          "abort",
          () => {
            set(internalPreviewId$, null);
          },
          { once: true },
        );
      }),
    ),
  };
}

export const introVideoStyleGallerySignals =
  createIntroVideoStyleGallerySignals();
