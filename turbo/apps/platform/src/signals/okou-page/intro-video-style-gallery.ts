import { command, computed, state } from "ccstate";

export const INTRO_VIDEO_STYLE_FORMATS = [
  "all",
  "16:9",
  "9:16",
  "1:1",
] as const;
type IntroVideoStyleFormat = (typeof INTRO_VIDEO_STYLE_FORMATS)[number];
function createIntroVideoStyleGallerySignals() {
  const internalFormat$ = state<IntroVideoStyleFormat>("all");
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
      }
    }),
  };
}

export const introVideoStyleGallerySignals =
  createIntroVideoStyleGallerySignals();
