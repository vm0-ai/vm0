import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { ExplainerVideoOptions } from "@okouai/api-contracts/contracts/explainer-video";
import {
  EXPLAINER_VIDEO_TEMPLATE_ID,
  explainerVideoTemplateOptions,
} from "@okouai/core/explainer-video-template";
import { command, computed, state } from "ccstate";

export type ExplainerVideoTab = "style" | "avatar" | "voice";

export function createExplainerVideoPickerSignals() {
  const tab$ = state<ExplainerVideoTab>("style");
  const style$ = state<ExplainerVideoOptions["style"] | null>(null);
  const avatar$ = state<ExplainerVideoOptions["avatar"]>({ kind: "none" });
  const voice$ = state<ExplainerVideoOptions["voice"] | null>(null);
  const search$ = state("");
  const group$ = state("all");
  return {
    tab$: computed((get) => {
      return get(tab$);
    }),
    style$: computed((get) => {
      return get(style$);
    }),
    avatar$: computed((get) => {
      return get(avatar$);
    }),
    voice$: computed((get) => {
      return get(voice$);
    }),
    search$: computed((get) => {
      return get(search$);
    }),
    group$: computed((get) => {
      return get(group$);
    }),
    template$: computed((get): GenerationTemplateRequest | null => {
      const style = get(style$);
      const voice = get(voice$);
      return style && voice
        ? {
            type: "video",
            selection: {
              stylePresetId: EXPLAINER_VIDEO_TEMPLATE_ID,
              explainerOptions: { style, avatar: get(avatar$), voice },
            },
          }
        : null;
    }),
    setTab$: command(({ set }, tab: ExplainerVideoTab) => {
      set(tab$, tab);
      set(search$, "");
      set(group$, "all");
    }),
    setStyle$: command(({ set }, style: ExplainerVideoOptions["style"]) => {
      set(style$, style);
    }),
    setAvatar$: command(
      ({ get, set }, avatar: ExplainerVideoOptions["avatar"]) => {
        set(avatar$, avatar);
        if (avatar.kind === "catalog" && get(voice$) === null) {
          set(voice$, { kind: "default" });
        }
      },
    ),
    setVoice$: command(({ set }, voice: ExplainerVideoOptions["voice"]) => {
      set(voice$, voice);
    }),
    setSearch$: command(({ set }, search: string) => {
      set(search$, search);
    }),
    setGroup$: command(({ set }, group: string) => {
      set(group$, group);
    }),
    restore$: command(({ set }, template: GenerationTemplateRequest | null) => {
      const options = explainerVideoTemplateOptions(template);
      set(tab$, "style");
      set(search$, "");
      set(group$, "all");
      set(style$, options?.style ?? null);
      set(avatar$, options?.avatar ?? { kind: "none" });
      set(voice$, options?.voice ?? null);
    }),
  };
}

export type ExplainerVideoPickerSignals = ReturnType<
  typeof createExplainerVideoPickerSignals
>;
