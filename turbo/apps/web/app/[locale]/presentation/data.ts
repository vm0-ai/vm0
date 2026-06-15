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

export function buildPresentationRemixHref(
  item: PresentationItem,
  appUrl: string,
  landingSearch = "",
): string {
  const url = new URL("/onboarding", appUrl);
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("showcase", item.embedUrl);
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

  return url.toString();
}
