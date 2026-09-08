import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

/** Canonical name of the organization default agent. */
export const DEFAULT_AGENT_DISPLAY_NAME = "Okou";

/**
 * The brand every new public-brand-scoped row is written with. Rows created
 * under the retired VM0 brand keep their stored value.
 */
export const PUBLIC_BRAND: PublicBrand = "okou";

export interface PublicBrandPresentation {
  readonly [key: string]: string;
  readonly assistantName: "Okou";
  readonly brandName: "Okou";
  readonly contactEmail: "contact@okou.ai";
  readonly supportEmail: "support@okou.ai";
}

export const PUBLIC_BRAND_PRESENTATION: PublicBrandPresentation = Object.freeze(
  {
    assistantName: "Okou",
    brandName: "Okou",
    contactEmail: "contact@okou.ai",
    supportEmail: "support@okou.ai",
  },
);

export function agentDisplayName(args: {
  readonly agentId: string;
  readonly defaultAgentId: string | null;
  readonly displayName: string | null;
}): string | null {
  if (args.agentId !== args.defaultAgentId) {
    return args.displayName;
  }

  return DEFAULT_AGENT_DISPLAY_NAME;
}
