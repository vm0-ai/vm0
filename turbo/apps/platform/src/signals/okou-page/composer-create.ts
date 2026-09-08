import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { i18n } from "../../i18n/index.ts";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";
import type { ComposerUiSignalGroups } from "./chat-composer.ts";

const COMPOSER_CREATE_MODES = ["presentation", "video", "image"] as const;

export type ComposerCreateMode = (typeof COMPOSER_CREATE_MODES)[number];
export type ComposerCreateCommand = ComposerCreateMode | "choose";

export function composerCreateCommandLabel(
  mode: ComposerCreateCommand,
): string {
  if (mode === "choose") {
    return i18n.t(($) => {
      return $.chat.composer.create.title;
    });
  }
  return composerCreateModeLabel(mode);
}

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

export function composerCreateModeName(mode: ComposerCreateMode): string {
  switch (mode) {
    case "presentation": {
      return i18n.t(($) => {
        return $.artifacts.kinds.presentation;
      });
    }
    case "image": {
      return i18n.t(($) => {
        return $.artifacts.kinds.image;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.artifacts.kinds.video;
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
  media: { readonly image: boolean; readonly video: boolean },
) {
  const modes = COMPOSER_CREATE_MODES.filter((mode) => {
    return (
      (mode !== "image" || media.image) && (mode !== "video" || media.video)
    );
  });
  const internalMode$ = state<ComposerCreateCommand | null>(null);
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ComposerCreateCommands];
  });
  const mode$ = computed((get) => {
    const mode = get(internalMode$);
    return get(enabled$) && mode !== "choose" ? mode : null;
  });
  const choosing$ = computed((get) => {
    return get(enabled$) && get(internalMode$) === "choose";
  });
  const setMode$ = command(
    ({ get, set }, mode: ComposerCreateCommand | null) => {
      if (!get(enabled$)) {
        return;
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
      if (mode !== "choose") {
        set(composer.focus$);
      }
    },
  );
  const selectCommand$ = command(
    ({ get, set }, mode: ComposerCreateCommand) => {
      if (!get(enabled$)) {
        return;
      }
      const range = get(composer.activeSlashRange$);
      if (range) {
        const head = composer.editor.state.selection.head;
        composer.editor.commands.deleteRange({
          from: head - (range.end - range.start),
          to: head,
        });
      }
      set(setMode$, mode);
    },
  );
  return { enabled$, modes, mode$, choosing$, setMode$, selectCommand$ };
}

export type ComposerCreateSignals = ReturnType<
  typeof createComposerCreateSignals
>;
