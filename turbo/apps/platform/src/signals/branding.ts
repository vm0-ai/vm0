import { computed } from "ccstate";

// Only okou.ai serves the app, so the product identity is no longer chosen
// from the page hostname.
export type BrandName = "Okou";
export type AssistantName = "Okou";

export const BRAND_NAME: BrandName = "Okou";
export const ASSISTANT_NAME: AssistantName = "Okou";

export const brandName$ = computed<BrandName>(() => {
  return BRAND_NAME;
});

export const assistantName$ = computed<AssistantName>(() => {
  return ASSISTANT_NAME;
});

// Computer Use currently follows the public assistant identity. Keep the
// domain-specific signal name for its existing consumers.
export const computerUseProductName$ = computed<AssistantName>((get) => {
  return get(assistantName$);
});
