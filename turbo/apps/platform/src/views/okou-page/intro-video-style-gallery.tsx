import { useTranslation } from "react-i18next";

export const INTRO_VIDEO_STYLE_TAGS = [
  "cinematic",
  "handmade",
  "retro-tech",
  "pop-culture",
  "print",
  "iconic-artist",
] as const;

export function useIntroVideoStyleGroupLabels() {
  const { t } = useTranslation();
  return {
    cinematic: t(($) => {
      return $.chat.introVideo.style.groups.cinematic;
    }),
    handmade: t(($) => {
      return $.chat.introVideo.style.groups.handmade;
    }),
    "retro-tech": t(($) => {
      return $.chat.introVideo.style.groups["retro-tech"];
    }),
    "pop-culture": t(($) => {
      return $.chat.introVideo.style.groups["pop-culture"];
    }),
    print: t(($) => {
      return $.chat.introVideo.style.groups.print;
    }),
    "iconic-artist": t(($) => {
      return $.chat.introVideo.style.groups["iconic-artist"];
    }),
    other: t(($) => {
      return $.chat.introVideo.style.groups.other;
    }),
  };
}
