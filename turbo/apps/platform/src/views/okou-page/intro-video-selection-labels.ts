import type { TFunction } from "i18next";
import type { IntroVideoOptions } from "@okouai/api-contracts/contracts/intro-video-options";

export function styleSelectionLabel(
  t: TFunction<"common">,
  selection: IntroVideoOptions["style"],
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
  selection: IntroVideoOptions["avatar"],
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
  selection: IntroVideoOptions["voice"],
  avatar: IntroVideoOptions["avatar"],
): string {
  switch (selection.kind) {
    case "default": {
      return avatar.kind === "catalog"
        ? t(($) => {
            return $.chat.introVideo.picker.avatarVoice;
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
