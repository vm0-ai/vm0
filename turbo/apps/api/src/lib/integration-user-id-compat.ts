type IntegrationUserIdResolution =
  | { readonly ok: true; readonly userId: string | null }
  | { readonly ok: false };

/**
 * Resolves the canonical and legacy integration-owner keys without allowing
 * conflicting identities to cross an OAuth boundary.
 *
 * Remove in #27602 only after the switched production API, previous API
 * version, and all in-flight OAuth/query/state payloads have drained.
 */
export function resolveIntegrationUserId(
  userId: string | null | undefined,
  legacyUserId: string | null | undefined,
): IntegrationUserIdResolution {
  if (
    userId !== null &&
    userId !== undefined &&
    legacyUserId !== null &&
    legacyUserId !== undefined &&
    userId !== legacyUserId
  ) {
    return { ok: false };
  }

  return { ok: true, userId: userId ?? legacyUserId ?? null };
}
