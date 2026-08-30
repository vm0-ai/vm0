import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

// Web has no context table, so contextType scopes these reserved UUID values
// to public-brand launch identity without widening the strict payload JSONB.
const WEB_PUBLIC_BRAND_CONTEXT_IDS = {
  vm0: "e1884e98-ab77-4eca-a420-90e591078804",
  okou: "0bdfae9e-63be-43dd-8193-a96e07787c20",
} satisfies Readonly<Record<PublicBrand, string>>;

// Mixed-version API fallback (new writer -> previous API queue drainer): the
// previous API ignores the additive private claim column, so these markers
// make it reject instead of draining the prompt as an ordinary launch. Gate:
// the outgoing API has finished draining and is outside retained rollback.
// Remove after no pending unrevoked/runless marker rows remain and the stale
// drain window has elapsed; follow-up #29908 owns the cleanup and verification.
const OFFICIAL_WORKFLOW_QUEUE_CONTEXT_IDS = {
  vm0: "d4f079af-190a-4a32-bf49-73175aa2d727",
  okou: "3f713f81-d611-47ec-a427-5a4844078890",
} satisfies Readonly<Record<PublicBrand, string>>;

interface WebChatQueueContext {
  readonly publicBrand: PublicBrand;
  readonly officialWorkflowClaimRequired: boolean;
}

/** Encode Web launch identity in the existing raw-event context boundary. */
export function webChatPublicBrandContextId(publicBrand: PublicBrand): string {
  return WEB_PUBLIC_BRAND_CONTEXT_IDS[publicBrand];
}

/** Mark a queued Web prompt whose later Run requires Official source authority. */
export function officialWorkflowQueueContextId(
  publicBrand: PublicBrand,
): string {
  return OFFICIAL_WORKFLOW_QUEUE_CONTEXT_IDS[publicBrand];
}

/** Decode a strict Official queue marker without rejecting ordinary pointers. */
export function officialWorkflowQueueContextFromContextId(
  contextId: string | null,
): WebChatQueueContext | null {
  if (contextId === OFFICIAL_WORKFLOW_QUEUE_CONTEXT_IDS.vm0) {
    return { publicBrand: "vm0", officialWorkflowClaimRequired: true };
  }
  if (contextId === OFFICIAL_WORKFLOW_QUEUE_CONTEXT_IDS.okou) {
    return { publicBrand: "okou", officialWorkflowClaimRequired: true };
  }
  return null;
}

/** Decode Web launch identity and whether a strict Official claim must exist. */
export function webChatQueueContextFromContextId(
  contextId: string | null,
): WebChatQueueContext {
  if (contextId === WEB_PUBLIC_BRAND_CONTEXT_IDS.vm0) {
    return { publicBrand: "vm0", officialWorkflowClaimRequired: false };
  }
  if (contextId === WEB_PUBLIC_BRAND_CONTEXT_IDS.okou) {
    return { publicBrand: "okou", officialWorkflowClaimRequired: false };
  }
  const officialContext = officialWorkflowQueueContextFromContextId(contextId);
  if (officialContext) {
    return officialContext;
  }
  throw new Error(`Invalid Web public-brand context: ${contextId}`);
}
