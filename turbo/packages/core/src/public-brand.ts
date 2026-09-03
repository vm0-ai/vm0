import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

/** Canonical name of the organization default agent on every public brand. */
export const DEFAULT_AGENT_DISPLAY_NAME = "Okou";

export interface PublicBrandPresentation {
  readonly [key: string]: string;
  readonly assistantName: "Zero" | "Okou";
  readonly brandName: "VM0" | "Okou";
  readonly contactEmail: "contact@vm0.ai" | "contact@okou.ai";
  readonly supportEmail: "support@vm0.ai" | "support@okou.ai";
}

const PUBLIC_BRAND_PRESENTATION = Object.freeze({
  vm0: Object.freeze({
    assistantName: "Zero",
    brandName: "VM0",
    contactEmail: "contact@vm0.ai",
    supportEmail: "support@vm0.ai",
  }),
  okou: Object.freeze({
    assistantName: "Okou",
    brandName: "Okou",
    contactEmail: "contact@okou.ai",
    supportEmail: "support@okou.ai",
  }),
}) satisfies Readonly<Record<PublicBrand, PublicBrandPresentation>>;

export function publicBrandPresentation(
  publicBrand: PublicBrand,
): PublicBrandPresentation {
  return PUBLIC_BRAND_PRESENTATION[publicBrand];
}

export function agentDisplayNameForPublicBrand(args: {
  readonly agentId: string;
  readonly defaultAgentId: string | null;
  readonly displayName: string | null;
  readonly publicBrand: PublicBrand;
}): string | null {
  if (args.agentId !== args.defaultAgentId) {
    return args.displayName;
  }

  return DEFAULT_AGENT_DISPLAY_NAME;
}

export function appUrlForPublicBrand(
  configuredAppUrl: string,
  publicBrand: PublicBrand,
): string {
  const url = new URL(configuredAppUrl);
  if (publicBrand === "okou" && url.hostname === "app.vm0.ai") {
    url.hostname = "app.okou.ai";
  } else if (publicBrand === "vm0" && url.hostname === "app.okou.ai") {
    url.hostname = "app.vm0.ai";
  }
  return url.toString().replace(/\/$/u, "");
}

export function apiUrlForPublicBrand(
  configuredApiUrl: string,
  publicBrand: PublicBrand,
): string {
  const url = new URL(configuredApiUrl);
  if (publicBrand === "okou" && url.hostname === "api.vm0.ai") {
    url.hostname = "api.okou.ai";
  } else if (publicBrand === "vm0" && url.hostname === "api.okou.ai") {
    url.hostname = "api.vm0.ai";
  }
  return url.toString().replace(/\/$/u, "");
}

/**
 * The static asset domains serve the same immutable object paths. Project only
 * the production hostname so previews, development URLs, and custom origins
 * remain unchanged.
 */
export function staticUrlForPublicBrand(
  configuredStaticUrl: string,
  publicBrand: PublicBrand,
): string {
  const url = new URL(configuredStaticUrl);
  if (publicBrand === "okou" && url.hostname === "static.vm0.io") {
    url.hostname = "static.okou.io";
  } else if (publicBrand === "vm0" && url.hostname === "static.okou.io") {
    url.hostname = "static.vm0.io";
  }
  const projectedUrl = url.toString();
  return configuredStaticUrl.endsWith("/")
    ? projectedUrl
    : projectedUrl.replace(/\/$/u, "");
}

/**
 * Both brands are served at the same time, so a single configured sending
 * domain cannot be correct for both. Map the production pair explicitly and
 * leave every other configured domain (preview, development, tests) untouched.
 */
export function fromDomainForPublicBrand(
  configuredFromDomain: string,
  publicBrand: PublicBrand,
): string {
  if (publicBrand === "okou" && configuredFromDomain === "vm0.bot") {
    return "okou.io";
  }
  if (publicBrand === "vm0" && configuredFromDomain === "okou.io") {
    return "vm0.bot";
  }
  return configuredFromDomain;
}
