import {
  publicBrandSchema,
  type PublicBrand,
} from "@okouai/api-contracts/contracts/public-brand";

const WEB_PUBLIC_BRAND_CONTEXT_PREFIX = "public-brand:";

/** Encode Web launch identity in the existing raw-event context boundary. */
export function webChatPublicBrandContextId(publicBrand: PublicBrand): string {
  return `${WEB_PUBLIC_BRAND_CONTEXT_PREFIX}${publicBrand}`;
}

/** Decode current Web context while preserving null for pre-rollout events. */
export function webChatPublicBrandFromContextId(
  contextId: string | null,
): PublicBrand | null {
  if (contextId === null) {
    return null;
  }
  if (!contextId.startsWith(WEB_PUBLIC_BRAND_CONTEXT_PREFIX)) {
    throw new Error(`Invalid Web public-brand context: ${contextId}`);
  }
  return publicBrandSchema.parse(
    contextId.slice(WEB_PUBLIC_BRAND_CONTEXT_PREFIX.length),
  );
}
