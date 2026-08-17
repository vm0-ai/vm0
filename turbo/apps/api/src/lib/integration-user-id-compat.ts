import { logger } from "./log";

const L = logger("IntegrationIdentityCompatibility");

export type IntegrationUserIdResolutionOutcome =
  | "empty"
  | "canonical_only"
  | "legacy_only_accepted"
  | "matching_dual_accepted"
  | "conflicting_dual_rejected";

export type IntegrationUserIdResolution =
  | {
      readonly ok: true;
      readonly userId: null;
      readonly outcome: "empty";
    }
  | {
      readonly ok: true;
      readonly userId: string;
      readonly outcome:
        | "canonical_only"
        | "legacy_only_accepted"
        | "matching_dual_accepted";
    }
  | { readonly ok: false; readonly outcome: "conflicting_dual_rejected" };

type IntegrationIdentityCompatibilityOutcome =
  | IntegrationUserIdResolutionOutcome
  | "legacy_signature_accepted";

/**
 * Emits only value-free compatibility dimensions. Canonical-only and empty
 * inputs are intentionally silent so normal traffic does not create noise.
 */
export function logIntegrationIdentityCompatibility(args: {
  readonly provider: "slack" | "teams" | "github";
  readonly surface: "query" | "state" | "signature";
  readonly outcome: IntegrationIdentityCompatibilityOutcome;
}): void {
  if (args.outcome === "canonical_only" || args.outcome === "empty") {
    return;
  }

  // Every emitted outcome is actionable for the time-boxed Contract gate.
  L.warn("Integration identity compatibility", {
    provider: args.provider,
    surface: args.surface,
    outcome: args.outcome,
  });
}

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
  if (userId === null || userId === undefined) {
    if (legacyUserId === null || legacyUserId === undefined) {
      return { ok: true, userId: null, outcome: "empty" };
    }

    return {
      ok: true,
      userId: legacyUserId,
      outcome: "legacy_only_accepted",
    };
  }

  if (legacyUserId === null || legacyUserId === undefined) {
    return { ok: true, userId, outcome: "canonical_only" };
  }

  if (userId !== legacyUserId) {
    return { ok: false, outcome: "conflicting_dual_rejected" };
  }

  return { ok: true, userId, outcome: "matching_dual_accepted" };
}
