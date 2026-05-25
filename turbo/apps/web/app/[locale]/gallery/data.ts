export type GalleryCategory =
  | "illustration"
  | "presentation"
  | "website"
  | "report"
  | "video"
  | "audio";

export type GalleryPreviewKind = "image" | "website" | "video" | "audio";

export interface GalleryItem {
  readonly slug: string;
  readonly category: GalleryCategory;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly previewImage: string;
  readonly previewKind: GalleryPreviewKind;
  readonly generationKind: string;
  readonly resourceHints?: readonly string[];
}

export const GALLERY_CATEGORIES: readonly (GalleryCategory | "all")[] = [
  "all",
  "illustration",
  "presentation",
  "website",
  "report",
  "video",
  "audio",
];

export const GALLERY_CATEGORY_LABELS: Record<GalleryCategory | "all", string> =
  {
    all: "All",
    illustration: "Illustration",
    presentation: "Presentation",
    website: "Website",
    report: "Report",
    video: "Video",
    audio: "Audio",
  };

export const GALLERY_ITEMS: readonly GalleryItem[] = [
  {
    slug: "notion-launch-illustration",
    category: "illustration",
    title: "Launch Plan Spot Illustration",
    description:
      "A lightweight product illustration style that can be selected from registry hints before image generation.",
    prompt:
      "Generate a clean Notion-style spot illustration of a product manager mapping a launch plan with cards, arrows, and a small product dashboard. Use the Notion Illustration image style if available, then generate the image as the primary artifact.",
    previewImage: "/assets/zero-avatar.png",
    previewKind: "image",
    generationKind: "image",
    resourceHints: ["vm0:image-style:notion-illustration"],
  },
  {
    slug: "investor-product-deck",
    category: "presentation",
    title: "Investor Product Deck",
    description:
      "An HTML presentation that uses Open Design templates and design systems as authoring resources.",
    prompt:
      "Generate an 8-slide HTML presentation for an investor update about Zero's multimodal generation roadmap. Include product thesis, user workflow, registry architecture, gallery examples, and next milestones.",
    previewImage: "/assets/mockup/web-ui-2.png",
    previewKind: "website",
    generationKind: "presentation",
    resourceHints: [
      "od:template:html-ppt-graphify-dark-graph",
      "od:skill:data-report",
    ],
  },
  {
    slug: "gallery-remix-website",
    category: "website",
    title: "Gallery Remix Website",
    description:
      "A website prompt that produces one hosted primary artifact with local generated media as supporting assets.",
    prompt:
      "Generate a polished website for a creative AI gallery where each item can be remixed into a new onboarding prompt. Use an image-led editorial layout and keep the generated website as the primary artifact.",
    previewImage: "/assets/mockup/web-ui-3.png",
    previewKind: "website",
    generationKind: "website",
    resourceHints: [
      "od:template:web-prototype-taste-editorial",
      "od:design-system:editorial",
    ],
  },
  {
    slug: "usage-intelligence-report",
    category: "report",
    title: "Usage Intelligence Report",
    description:
      "A source-backed report example that treats tables and charts as supporting assets inside one output directory.",
    prompt:
      "Generate a concise executive report about multimodal generation usage trends. Include a summary, ranked opportunities, risks, and a clear recommendation section. Use realistic placeholder data if live sources are unavailable.",
    previewImage: "/assets/bg_4.webp",
    previewKind: "website",
    generationKind: "report",
    resourceHints: ["od:skill:data-report", "od:template:finance-report"],
  },
  {
    slug: "product-intro-video",
    category: "video",
    title: "Product Intro Video",
    description:
      "A video-first gallery item that keeps video as the primary artifact and poster frames as supporting assets.",
    prompt:
      "Generate a short product intro video concept for Zero's built-in multimodal generation. Show the user entering a prompt, registry selecting resources, and a finished artifact appearing in gallery.",
    previewImage: "/assets/bg_1.webp",
    previewKind: "video",
    generationKind: "video",
    resourceHints: ["executor:built-in-video"],
  },
  {
    slug: "warm-voiceover",
    category: "audio",
    title: "Warm Product Voiceover",
    description:
      "A voice/audio prompt where the audio file is the primary output and transcript metadata can travel with it.",
    prompt:
      "Generate a warm 30-second voiceover introducing Zero's gallery remix flow. The script should explain that users can open a gallery item, remix the prompt, and generate a new artifact.",
    previewImage: "/assets/tool-sync/zero-chat.png",
    previewKind: "audio",
    generationKind: "audio",
    resourceHints: ["executor:built-in-voice"],
  },
];

export function buildGalleryPromptHref(
  item: GalleryItem,
  platformUrl: string,
): string {
  const url = new URL("/onboarding", platformUrl);
  const hintText =
    item.resourceHints && item.resourceHints.length > 0
      ? `\n\nResource hints: ${item.resourceHints.join(", ")}`
      : "";

  url.searchParams.set("prompt", `${item.prompt}${hintText}`);
  return url.toString();
}
