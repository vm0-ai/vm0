import { computed } from "ccstate";

type Branding = "vm0" | "okou";
export type BrandName = "VM0" | "Okou";
type ComputerUseProductName = "Zero" | "Okou";

const OKOU_ROOT_DOMAINS = ["okou.ai", "omby.ai", "okou-app.pages.dev"] as const;

export function resolveBrandNameForHostname(hostname: string): BrandName {
  const normalizedHostname = hostname.toLowerCase().replace(/:\d+$/u, "");
  const isOkou = OKOU_ROOT_DOMAINS.some((domain) => {
    return (
      normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`)
    );
  });

  return isOkou ? "Okou" : "VM0";
}

const branding$ = computed<Branding>(() => {
  return resolveBrandNameForHostname(location.host) === "Okou" ? "okou" : "vm0";
});

export const brandName$ = computed<BrandName>((get) => {
  return get(branding$) === "okou" ? "Okou" : "VM0";
});

export const computerUseProductName$ = computed<ComputerUseProductName>(
  (get) => {
    return get(branding$) === "okou" ? "Okou" : "Zero";
  },
);
