import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

// Web has no context table, so contextType scopes these reserved UUID values
// to public-brand launch identity without widening the strict payload JSONB.
const WEB_PUBLIC_BRAND_CONTEXT_IDS = {
  vm0: "e1884e98-ab77-4eca-a420-90e591078804",
  okou: "0bdfae9e-63be-43dd-8193-a96e07787c20",
} satisfies Readonly<Record<PublicBrand, string>>;

// Persisted queue compatibility (#29908): writers retain these markers while
// readers prepare to accept normal brand IDs with the private Official claim.
// Cut writers over only after marker-only readers drain and exit rollback.
// Retire marker decoding in a later release after marker writers are excluded
// from serving/rollback, no unrevoked runless marker prompts remain, and stale
// recovery is verified. Immutable raw/snapshot history must stay readable.
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
function officialWorkflowQueueContextFromContextId(
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

/** Decode either brand encoding; an ordinary agent source pointer is not a brand. */
export function webChatQueueContextFromContextId(
  contextId: string | null,
): WebChatQueueContext | null {
  if (contextId === WEB_PUBLIC_BRAND_CONTEXT_IDS.vm0) {
    return { publicBrand: "vm0", officialWorkflowClaimRequired: false };
  }
  if (contextId === WEB_PUBLIC_BRAND_CONTEXT_IDS.okou) {
    return { publicBrand: "okou", officialWorkflowClaimRequired: false };
  }
  return officialWorkflowQueueContextFromContextId(contextId);
}
