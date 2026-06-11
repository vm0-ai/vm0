import {
  PRESENTATION_TEMPLATE_ITEMS,
  type PresentationTemplateItem,
} from "@vm0/core";

export type PresentationItem = PresentationTemplateItem;

export const PRESENTATION_ITEMS = PRESENTATION_TEMPLATE_ITEMS;

const PRESENTATION_ATTRIBUTION_PARAM = "vm0_source";
const PRESENTATION_ATTRIBUTION_VALUE = "presentation";

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

function appendAttribution(url: URL, landingSearch: string): void {
  url.searchParams.set(
    PRESENTATION_ATTRIBUTION_PARAM,
    PRESENTATION_ATTRIBUTION_VALUE,
  );

  const landingParams = new URLSearchParams(landingSearch);
  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of landingParams.getAll(param)) {
      url.searchParams.append(param, value);
    }
  }
}

export function buildPresentationRemixHref(
  item: PresentationItem,
  appUrl: string,
  landingSearch = "",
): string {
  const url = new URL("/onboarding", appUrl);
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("showcase", item.embedUrl);
  appendAttribution(url, landingSearch);

  return url.toString();
}

export function buildPresentationStartHref(
  appUrl: string,
  landingSearch = "",
): string {
  const url = new URL("/onboarding", appUrl);
  appendAttribution(url, landingSearch);

  return url.toString();
}

export type PresentationCategory =
  | "Pitch deck"
  | "Product launch"
  | "Tech talk"
  | "Weekly report"
  | "Course module"
  | "Creative";

const TEMPLATE_CATEGORY: Record<string, PresentationCategory> = {
  "template:html-ppt-pitch-deck": "Pitch deck",
  "template:html-ppt-product-launch": "Product launch",
  "template:html-ppt-tech-sharing": "Tech talk",
  "template:html-ppt-weekly-report": "Weekly report",
  "template:html-ppt-course-module": "Course module",
};

export function getPresentationCategory(
  item: PresentationItem,
): PresentationCategory {
  return TEMPLATE_CATEGORY[item.templateId] ?? "Creative";
}

export const PRESENTATION_CATEGORIES: readonly PresentationCategory[] = [
  "Pitch deck",
  "Product launch",
  "Tech talk",
  "Weekly report",
  "Course module",
  "Creative",
];

interface PresentationFaq {
  readonly question: string;
  readonly answer: string;
}

export const PRESENTATION_FAQS: readonly PresentationFaq[] = [
  {
    question: "How does VM0's AI presentation maker work?",
    answer:
      "Describe your topic, audience, and preferred style in a single prompt. Zero — VM0's AI teammate — writes the narrative, structures the slides, chooses layouts, and renders charts in the design system you pick. You get a complete, editable deck in minutes.",
  },
  {
    question: "What formats can I export to?",
    answer:
      "Every deck can be exported to PowerPoint (PPTX), PDF, or self-hosted HTML. The HTML version is fully responsive and can be shared as a live link.",
  },
  {
    question: "Can I match my own style?",
    answer:
      "Yes. Choose from 60+ beautifully crafted design systems, or supply your own colors, fonts, and logo so every slide looks the way you want.",
  },
  {
    question: "Can I edit the deck after it's generated?",
    answer:
      "Absolutely. Edit any slide in the live editor, or regenerate individual sections with a follow-up prompt. Nothing is locked.",
  },
  {
    question: "How many slides can VM0 generate?",
    answer:
      "From a quick 5-slide summary to a full 20+ slide deck. Tell VM0 how long you want it, or let it choose the right length for your topic.",
  },
  {
    question: "Is it free to try?",
    answer:
      "You can start for free and generate your first deck right away. Larger or recurring workloads are covered by VM0 credits on the Pro plan.",
  },
];
