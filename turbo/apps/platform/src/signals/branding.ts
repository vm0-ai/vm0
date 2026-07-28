import { computed } from "ccstate";

type Branding = "vm0" | "okou";

const OKOU_ROOT_DOMAINS = ["okou.ai", "omby.ai", "okou-app.pages.dev"] as const;

export const branding$ = computed<Branding>(() => {
  const hostname = location.host.toLowerCase().replace(/:\d+$/u, "");
  const isOkou = OKOU_ROOT_DOMAINS.some((domain) => {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });

  return isOkou ? "okou" : "vm0";
});
