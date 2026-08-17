import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

// Web has no context table, so contextType scopes these reserved UUID values
// to public-brand launch identity without widening the strict payload JSONB.
const WEB_PUBLIC_BRAND_CONTEXT_IDS = {
  vm0: "e1884e98-ab77-4eca-a420-90e591078804",
  okou: "0bdfae9e-63be-43dd-8193-a96e07787c20",
} satisfies Readonly<Record<PublicBrand, string>>;

/** Encode Web launch identity in the existing raw-event context boundary. */
export function webChatPublicBrandContextId(publicBrand: PublicBrand): string {
  return WEB_PUBLIC_BRAND_CONTEXT_IDS[publicBrand];
}

/** Decode current Web context while preserving null for pre-rollout events. */
export function webChatPublicBrandFromContextId(
  contextId: string | null,
): PublicBrand | null {
  if (contextId === null) {
    return null;
  }
  if (contextId === WEB_PUBLIC_BRAND_CONTEXT_IDS.vm0) {
    return "vm0";
  }
  if (contextId === WEB_PUBLIC_BRAND_CONTEXT_IDS.okou) {
    return "okou";
  }
  throw new Error(`Invalid Web public-brand context: ${contextId}`);
}
