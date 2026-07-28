import { computed } from "ccstate";

type Branding = "vm0" | "okou";
export type BrandName = "VM0" | "Okou";

const OKOU_ROOT_DOMAINS = ["okou.ai", "omby.ai", "okou-app.pages.dev"] as const;

const branding$ = computed<Branding>(() => {
  const hostname = location.host.toLowerCase().replace(/:\d+$/u, "");
  const isOkou = OKOU_ROOT_DOMAINS.some((domain) => {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });

  return isOkou ? "okou" : "vm0";
});

export const brandName$ = computed<BrandName>((get) => {
  return get(branding$) === "okou" ? "Okou" : "VM0";
});
