type IntegrationUserIdResolution =
  | { readonly ok: true; readonly userId: string | null }
  | { readonly ok: false };

/**
 * Resolves the canonical and legacy integration-owner keys without allowing
 * conflicting identities to cross an OAuth boundary.
 *
 * Old web/app OAuth inputs have an observed maximum exposure of ~2 days.
 * Remove in #27602 only after the switched API is healthy, the previous API
 * version has drained, and legacy query/state inputs are no longer required.
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
