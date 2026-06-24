import { VIDEO_TEMPLATE_ITEMS, type VideoTemplateItem } from "@vm0/core";
import { buildVm0OnboardingEntryUrl } from "../../../src/lib/zero/onboardingEntryUrl";

export interface VideoItem extends VideoTemplateItem {
  readonly prompt: string;
}

const VIDEO_ATTRIBUTION_PARAM = "vm0_source";
const VIDEO_ATTRIBUTION_VALUE = "video";

const AD_ATTRIBUTION_PARAMS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const VIDEO_PROMPTS: Readonly<Record<string, string>> = {
  "epic-grandeur":
    "/gen video with video template `epic-grandeur`, create a 12-second cinematic launch teaser for Aster Ridge, a mountain observatory opening at sunrise. Use sweeping aerial scale, golden backlight, slow camera movement, and a final title card.",
  "gourmet-documentary":
    "/gen video with video template `gourmet-documentary`, create a 12-second documentary spot for Hearth & Grain, an artisan bakery introducing its morning sourdough ritual. Focus on macro crust texture, steam, warm backlight, and hands at work.",
  "luxury-product":
    "/gen video with video template `luxury-product`, create a 10-second product reveal for a black ceramic chronograph watch. Use a dark studio, pinpoint highlights, premium material detail, slow macro movement, and a refined final lockup.",
  "shortform-viral":
    "/gen video with video template `shortform-viral`, create a 9:16 creator-style teaser for a desk setup upgrade. Start with a fast visual hook, use handheld energy, bright color, quick cuts, and end with a simple call to action.",
  "fashion-editorial":
    "/gen video with video template `fashion-editorial`, create a 12-second editorial film for a winter capsule collection in a concrete gallery. Use cold desaturated color, strong silhouettes, luxury fabric texture, and deliberate pose changes.",
  "sports-performance-ad":
    "/gen video with video template `sports-performance-ad`, create a 12-second performance ad for a carbon-plate running shoe. Show athlete effort, gear close-ups, impact rhythm, dramatic rim light, and a confident product end frame.",
  "japanese-wabi-sabi":
    "/gen video with video template `japanese-wabi-sabi`, create a 12-second quiet lifestyle film for a ceramic tea set in a morning kitchen. Use warm soft light, natural imperfection, negative space, and slow, calm motion.",
  "hand-drawn-fantasy-anime":
    "/gen video with video template `hand-drawn-fantasy-anime`, create a 12-second fantasy animation moment where a young mapmaker discovers a floating lantern forest. Use painterly 2D backgrounds, expressive character motion, and gentle wonder.",
  "cyberpunk-anime":
    "/gen video with video template `cyberpunk-anime`, create a 12-second 2D anime scene of a courier crossing a neon megacity at night. Use rain-slick streets, cel shading, glowing signage, and a melancholic final beat.",
  "chinese-ink-art":
    "/gen video with video template `chinese-ink-art`, create a 12-second ink-wash scene of cranes crossing misty mountains at dawn. Use monochrome brush texture, white space, drifting mist, and a calm classical-poetry mood.",
};

export const VIDEO_ITEMS: readonly VideoItem[] = VIDEO_TEMPLATE_ITEMS.map(
  (item) => {
    return {
      ...item,
      prompt: videoPrompt(item),
    };
  },
);

function videoPrompt(item: VideoTemplateItem): string {
  const prompt = VIDEO_PROMPTS[item.slug];
  if (!prompt) {
    throw new Error(`Missing video prompt: ${item.slug}`);
  }

  return prompt;
}

export function buildVideoRemixHref(
  item: VideoItem,
  appUrl: string,
  landingSearch = "",
): string {
  void appUrl;

  const params = new URLSearchParams();
  params.set("prompt", item.prompt);
  params.set("showcase", item.previewVideo);
  params.set(VIDEO_ATTRIBUTION_PARAM, VIDEO_ATTRIBUTION_VALUE);

  const landingParams = new URLSearchParams(landingSearch);
  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of landingParams.getAll(param)) {
      params.append(param, value);
    }
  }

  return buildVm0OnboardingEntryUrl(params);
}
