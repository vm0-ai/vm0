export const INTRO_VIDEO_TEMPLATES_ENABLED_ENV =
  "OKOU_INTRO_VIDEO_TEMPLATES_ENABLED";

export interface IntroVideoTemplateItem {
  readonly id: `intro-video-template:${string}`;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly previewQuote: string;
  readonly story: {
    readonly pattern: string;
    readonly beats: readonly string[];
  };
  readonly implementation: {
    readonly type: "hyperframes";
    readonly label: "HyperFrames";
    readonly workflow: "faceless-explainer" | "product-launch-video";
    readonly motion: {
      readonly blueprintIds: readonly string[];
      readonly ruleIds: readonly string[];
    };
  };
  readonly framingRule: string;
}

/** Temporary seed item; replace this catalog entry when the rendered templates ship. */
export const INTRO_VIDEO_TEMPLATE_ITEMS: readonly IntroVideoTemplateItem[] = [
  {
    id: "intro-video-template:interview",
    slug: "interview",
    title: "Interview",
    description:
      "Turn an interview transcript into a focused, quote-led explainer.",
    previewQuote: "“What changed your mind?”",
    story: {
      pattern: "quote-led interview",
      beats: [
        "Open on the strongest quote",
        "Name the question or tension",
        "Build the central insight",
        "Prove it with one example or data point",
        "Land one memorable takeaway",
      ],
    },
    implementation: {
      type: "hyperframes",
      label: "HyperFrames",
      workflow: "faceless-explainer",
      motion: {
        blueprintIds: [
          "kinetic-type-beats",
          "fixed-anchor-cycle",
          "comparison-split",
          "dataviz-countup",
        ],
        ruleIds: [
          "asr-keyword-glow",
          "spring-pop-entrance",
          "stat-bars-and-fills",
          "depth-of-field-blur",
        ],
      },
    },
    framingRule:
      "Give each beat one dominant visual focus; crop into the relevant detail instead of keeping a whole interface on screen.",
  },
];

export function findIntroVideoTemplateItem(
  idOrSlug: string,
): IntroVideoTemplateItem | undefined {
  return INTRO_VIDEO_TEMPLATE_ITEMS.find((item) => {
    return item.id === idOrSlug || item.slug === idOrSlug;
  });
}
