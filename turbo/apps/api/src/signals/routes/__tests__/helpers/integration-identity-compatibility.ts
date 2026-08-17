import { EVENT } from "@axiomhq/logging";

const INTEGRATION_IDENTITY_COMPATIBILITY_MESSAGE =
  "Integration identity compatibility";

type EmittedIntegrationIdentityCompatibilityOutcome =
  | "legacy_only_accepted"
  | "matching_dual_accepted"
  | "conflicting_dual_rejected"
  | "legacy_signature_accepted";

interface ExpectedIntegrationIdentityCompatibilityEvent {
  readonly provider: "slack" | "teams" | "github";
  readonly surface: "query" | "state" | "signature";
  readonly outcome: EmittedIntegrationIdentityCompatibilityOutcome;
}

export function integrationIdentityCompatibilityEvents(
  calls: readonly (readonly unknown[])[],
): readonly Readonly<Record<PropertyKey, unknown>>[] {
  return calls.flatMap((call) => {
    const [message, fields] = call;
    if (
      message !== INTEGRATION_IDENTITY_COMPATIBILITY_MESSAGE ||
      typeof fields !== "object" ||
      fields === null ||
      Array.isArray(fields)
    ) {
      return [];
    }
    return [fields as Readonly<Record<PropertyKey, unknown>>];
  });
}

export function expectedIntegrationIdentityCompatibilityEvent(
  args: ExpectedIntegrationIdentityCompatibilityEvent,
): Readonly<Record<PropertyKey, unknown>> {
  return {
    [EVENT]: { source: "api" },
    provider: args.provider,
    surface: args.surface,
    outcome: args.outcome,
    context: "IntegrationIdentityCompatibility",
  };
}
