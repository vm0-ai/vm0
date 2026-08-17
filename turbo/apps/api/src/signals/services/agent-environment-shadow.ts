import {
  expandVariables,
  expandVariablesInString,
} from "@okouai/core/variable-expander";

import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "./agent-execution-plan";

export const ENVIRONMENT_SHADOW_COUNT_BUCKETS = [
  "0",
  "1",
  "2_4",
  "5_8",
  "9_16",
  "17_plus",
] as const;

export type EnvironmentShadowCountBucket =
  (typeof ENVIRONMENT_SHADOW_COUNT_BUCKETS)[number];

export type EnvironmentShadowClassification =
  | "exact"
  | "legacy_only_bindings"
  | "candidate_only_bindings"
  | "value_override_difference"
  | "mixed_difference"
  | "shadow_unavailable";

type AvailableEnvironmentShadowClassification = Exclude<
  EnvironmentShadowClassification,
  "shadow_unavailable"
>;

export type EnvironmentShadowObservation =
  | {
      readonly classification: AvailableEnvironmentShadowClassification;
      readonly legacyOnlyCountBucket: EnvironmentShadowCountBucket;
      readonly candidateOnlyCountBucket: EnvironmentShadowCountBucket;
      readonly sharedValueDifferenceCountBucket: EnvironmentShadowCountBucket;
    }
  | {
      readonly classification: "shadow_unavailable";
    };

export interface ApplicationOwnedEnvironmentCandidateInput {
  readonly modelProviderEnvironment:
    | Readonly<Record<string, string>>
    | undefined;
  readonly storedConnectorEnvironment:
    | Readonly<Record<string, string>>
    | undefined;
  readonly vars: Readonly<Record<string, string>> | undefined;
  readonly connectorVars: Readonly<Record<string, string>> | undefined;
  readonly secrets: Readonly<Record<string, string>> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly systemAndRunEnvironment:
    | Readonly<Record<string, string>>
    | undefined;
  readonly runtimeOverrides: Readonly<Record<string, string>>;
}

/**
 * Builds the application-owned environment without reading Compose content.
 * All inputs are resolved by the existing launch path before this pure step.
 */
export function buildApplicationOwnedEnvironmentCandidate(
  args: ApplicationOwnedEnvironmentCandidateInput,
): Record<string, string> {
  const providerEnvironment = { ...args.modelProviderEnvironment };
  const variableSources = args.vars ? { ...args.vars } : undefined;
  const connectorVariableSources = args.connectorVars
    ? { ...args.connectorVars }
    : undefined;
  const secretSources = {
    ...args.secrets,
    ...args.environmentSecretPlaceholders,
  };
  const providerExpansion = expandVariables(providerEnvironment, {
    vars: variableSources,
    secrets: secretSources,
  });
  if (providerExpansion.missingVars.length > 0) {
    throw new Error("Application-owned environment candidate is unavailable");
  }

  const acceptedStoredConnectorEntries = Object.entries(
    args.storedConnectorEnvironment ?? {},
  ).filter(([key]) => {
    return !Object.hasOwn(providerEnvironment, key);
  });
  const expandedStoredConnectorEntries = acceptedStoredConnectorEntries.map(
    ([key, value]) => {
      const expansion = expandVariablesInString(value, {
        vars: connectorVariableSources,
        secrets: secretSources,
      });
      if (expansion.missingVars.length > 0) {
        throw new Error(
          "Application-owned environment candidate is unavailable",
        );
      }
      return [key, expansion.result] as const;
    },
  );
  const assembled = {
    ...providerExpansion.result,
    ...Object.fromEntries(expandedStoredConnectorEntries),
    ...args.systemAndRunEnvironment,
    ...args.runtimeOverrides,
  };
  return Object.fromEntries(
    Object.entries(assembled).filter(([key]) => {
      return !APPLICATION_OWNED_AGENT_EXECUTION_PLAN.environment.legacyRemovedPrefixes.some(
        (prefix) => {
          return key.startsWith(prefix);
        },
      );
    }),
  );
}

/** Compares exact, unredacted maps and immediately reduces them to buckets. */
export function compareApplicationOwnedEnvironment(
  legacyEnvironment: Readonly<Record<string, string>>,
  candidateEnvironment: Readonly<Record<string, string>>,
): EnvironmentShadowObservation {
  let legacyOnlyCount = 0;
  let candidateOnlyCount = 0;
  let sharedValueDifferenceCount = 0;

  for (const [key, legacyValue] of Object.entries(legacyEnvironment)) {
    if (!Object.hasOwn(candidateEnvironment, key)) {
      legacyOnlyCount += 1;
    } else if (candidateEnvironment[key] !== legacyValue) {
      sharedValueDifferenceCount += 1;
    }
  }
  for (const key of Object.keys(candidateEnvironment)) {
    if (!Object.hasOwn(legacyEnvironment, key)) {
      candidateOnlyCount += 1;
    }
  }

  let classification: AvailableEnvironmentShadowClassification;
  if (
    legacyOnlyCount === 0 &&
    candidateOnlyCount === 0 &&
    sharedValueDifferenceCount === 0
  ) {
    classification = "exact";
  } else if (
    legacyOnlyCount > 0 &&
    candidateOnlyCount === 0 &&
    sharedValueDifferenceCount === 0
  ) {
    classification = "legacy_only_bindings";
  } else if (
    legacyOnlyCount === 0 &&
    candidateOnlyCount > 0 &&
    sharedValueDifferenceCount === 0
  ) {
    classification = "candidate_only_bindings";
  } else if (
    legacyOnlyCount === 0 &&
    candidateOnlyCount === 0 &&
    sharedValueDifferenceCount > 0
  ) {
    classification = "value_override_difference";
  } else {
    classification = "mixed_difference";
  }
  const countBucket = (count: number): EnvironmentShadowCountBucket => {
    if (count <= 0) {
      return "0";
    }
    if (count === 1) {
      return "1";
    }
    if (count <= 4) {
      return "2_4";
    }
    if (count <= 8) {
      return "5_8";
    }
    if (count <= 16) {
      return "9_16";
    }
    return "17_plus";
  };

  return {
    classification,
    legacyOnlyCountBucket: countBucket(legacyOnlyCount),
    candidateOnlyCountBucket: countBucket(candidateOnlyCount),
    sharedValueDifferenceCountBucket: countBucket(sharedValueDifferenceCount),
  };
}
