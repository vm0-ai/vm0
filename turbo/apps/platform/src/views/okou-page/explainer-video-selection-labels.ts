import type { TFunction } from "i18next";
import type { ExplainerVideoOptions } from "@okouai/api-contracts/contracts/explainer-video";

export function styleSelectionLabel(
  t: TFunction<"common">,
  selection: ExplainerVideoOptions["style"],
): string {
  switch (selection.kind) {
    case "auto": {
      return t(($) => {
        return $.chat.introVideo.style.auto;
      });
    }
    case "catalog": {
      return selection.style.name;
    }
  }
}

export function avatarSelectionLabel(
  t: TFunction<"common">,
  selection: ExplainerVideoOptions["avatar"],
): string {
  switch (selection.kind) {
    case "none": {
      return t(($) => {
        return $.chat.introVideo.avatar.none;
      });
    }
    case "catalog": {
      return selection.avatar.name;
    }
  }
}

export function voiceSelectionLabel(
  t: TFunction<"common">,
  selection: ExplainerVideoOptions["voice"],
  avatar: ExplainerVideoOptions["avatar"],
): string {
  switch (selection.kind) {
    case "default": {
      return avatar.kind === "catalog"
        ? t(($) => {
            return $.chat.explainerVideo.avatarVoice;
          })
        : t(($) => {
            return $.chat.introVideo.voice.auto;
          });
    }
    case "none": {
      return t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
    case "catalog": {
      return selection.voice.name;
    }
  }
}
