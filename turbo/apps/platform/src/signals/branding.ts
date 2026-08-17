import { computed } from "ccstate";
import { isOkouHostname } from "../lib/platform-host.ts";

type Branding = "vm0" | "okou";
export type BrandName = "VM0" | "Okou";
export type AssistantName = "Zero" | "Okou";

export function resolveBrandNameForHostname(hostname: string): BrandName {
  return isOkouHostname(hostname) ? "Okou" : "VM0";
}

export function resolveAssistantNameForHostname(
  hostname: string,
): AssistantName {
  return resolveBrandNameForHostname(hostname) === "Okou" ? "Okou" : "Zero";
}

const branding$ = computed<Branding>(() => {
  return resolveBrandNameForHostname(location.hostname) === "Okou"
    ? "okou"
    : "vm0";
});

export const brandName$ = computed<BrandName>((get) => {
  return get(branding$) === "okou" ? "Okou" : "VM0";
});

export const assistantName$ = computed<AssistantName>((get) => {
  return get(branding$) === "okou" ? "Okou" : "Zero";
});

// Computer Use currently follows the public assistant identity. Keep the
// domain-specific signal name for its existing consumers.
export const computerUseProductName$ = computed<AssistantName>((get) => {
  return get(assistantName$);
});
