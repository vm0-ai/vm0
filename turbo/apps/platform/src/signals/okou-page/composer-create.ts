import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { i18n } from "../../i18n/index.ts";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";
import type { ComposerUiSignalGroups } from "./chat-composer.ts";

export const COMPOSER_CREATE_MODES = [
  "video",
  "presentation",
  "image",
] as const;

export type ComposerCreateMode = (typeof COMPOSER_CREATE_MODES)[number];

export function composerCreateModeLabel(mode: ComposerCreateMode): string {
  switch (mode) {
    case "image": {
      return i18n.t(($) => {
        return $.chat.composer.create.image;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.chat.composer.create.video;
      });
    }
    case "presentation": {
      return i18n.t(($) => {
        return $.chat.composer.create.presentation;
      });
    }
  }
}

export function composerCreatePlaceholder(mode: ComposerCreateMode): string {
  switch (mode) {
    case "image": {
      return i18n.t(($) => {
        return $.chat.composer.create.imagePlaceholder;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.chat.composer.create.videoPlaceholder;
      });
    }
    case "presentation": {
      return i18n.t(($) => {
        return $.chat.composer.create.presentationPlaceholder;
      });
    }
  }
}

export function createComposerCreateSignals(
  composer: WorkflowComposerSignals,
  ui: ComposerUiSignalGroups,
) {
  const internalMode$ = state<ComposerCreateMode | null>(null);
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ComposerCreateCommands];
  });
  const mode$ = computed((get) => {
    return get(enabled$) ? get(internalMode$) : null;
  });
  const setMode$ = command(({ get, set }, mode: ComposerCreateMode | null) => {
    if (!get(enabled$)) {
      return;
    }
    const range = get(composer.activeSlashRange$);
    if (mode && range) {
      const head = composer.editor.state.selection.head;
      composer.editor
        .chain()
        .focus()
        .deleteRange({ from: head - (range.end - range.start), to: head })
        .run();
    }
    set(internalMode$, mode);
    set(composer.closeSuggestionMenu$);
    set(ui.model.setModelPickerOpen$, false);
    set(
      ui.model.setMediaModelCategory$,
      mode === "image" || mode === "video" ? mode : null,
    );
    set(ui.videoOptions.setVideoOptionsOpen$, false);
    if (mode !== "video") {
      set(ui.videoOptions.setVideoRunOptions$, {});
    }
    set(composer.focus$);
  });
  return { enabled$, mode$, setMode$ };
}

export type ComposerCreateSignals = ReturnType<
  typeof createComposerCreateSignals
>;
