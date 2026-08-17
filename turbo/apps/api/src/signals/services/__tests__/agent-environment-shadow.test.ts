import { describe, expect, it } from "vitest";

import {
  buildApplicationOwnedEnvironmentCandidate,
  compareApplicationOwnedEnvironment,
  type ApplicationOwnedEnvironmentCandidateInput,
  type EnvironmentShadowObservation,
} from "../agent-environment-shadow";

function candidateInput(
  overrides: Partial<ApplicationOwnedEnvironmentCandidateInput> = {},
): ApplicationOwnedEnvironmentCandidateInput {
  return {
    modelProviderEnvironment: undefined,
    storedConnectorEnvironment: undefined,
    vars: undefined,
    connectorVars: undefined,
    secrets: undefined,
    environmentSecretPlaceholders: undefined,
    systemAndRunEnvironment: undefined,
    runtimeOverrides: {},
    ...overrides,
  };
}

function bindings(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      return [`BINDING_${index}`, `value-${index}`];
    }),
  );
}

interface EnvironmentComparisonCase {
  readonly name: string;
  readonly legacy: Readonly<Record<string, string>>;
  readonly candidate: Readonly<Record<string, string>>;
  readonly expected: EnvironmentShadowObservation;
}

describe("application-owned environment candidate", () => {
  it("assembles code-owned identity and token without a legacy input", () => {
    const candidate = buildApplicationOwnedEnvironmentCandidate(
      candidateInput({
        modelProviderEnvironment: {
          MODEL_TOKEN: `\${{ secrets.MODEL_TOKEN }}`,
        },
        secrets: { MODEL_TOKEN: "resolved-model-token" },
        systemAndRunEnvironment: {
          OKOU_AGENT_ID: "agent-id",
          OKOU_TOKEN: "okou-token",
        },
        runtimeOverrides: {
          CLI_PKG_URL: "https://static.example.test/cli.tgz",
          OKOU_WEBSITE_TEMPLATE_ARCHIVE_VERSION: "latest",
        },
      }),
    );

    expect(candidate).toStrictEqual({
      MODEL_TOKEN: "resolved-model-token",
      OKOU_AGENT_ID: "agent-id",
      OKOU_TOKEN: "okou-token",
      CLI_PKG_URL: "https://static.example.test/cli.tgz",
      OKOU_WEBSITE_TEMPLATE_ARCHIVE_VERSION: "latest",
    });
  });

  it("expands provider-only bindings from Run variables and secrets", () => {
    expect(
      buildApplicationOwnedEnvironmentCandidate(
        candidateInput({
          modelProviderEnvironment: {
            PROVIDER_VARIABLE: `\${{ vars.PROVIDER_VARIABLE }}`,
            PROVIDER_SECRET: `\${{ secrets.PROVIDER_SECRET }}`,
          },
          vars: { PROVIDER_VARIABLE: "provider-variable" },
          secrets: { PROVIDER_SECRET: "provider-secret" },
        }),
      ),
    ).toStrictEqual({
      PROVIDER_VARIABLE: "provider-variable",
      PROVIDER_SECRET: "provider-secret",
    });
  });

  it("expands Connector-only bindings from Connector variables and secrets", () => {
    expect(
      buildApplicationOwnedEnvironmentCandidate(
        candidateInput({
          storedConnectorEnvironment: {
            CONNECTOR_VARIABLE: `\${{ vars.CONNECTOR_VARIABLE }}`,
            CONNECTOR_SECRET: `\${{ secrets.CONNECTOR_SECRET }}`,
          },
          connectorVars: { CONNECTOR_VARIABLE: "connector-variable" },
          secrets: { CONNECTOR_SECRET: "connector-secret" },
        }),
      ),
    ).toStrictEqual({
      CONNECTOR_VARIABLE: "connector-variable",
      CONNECTOR_SECRET: "connector-secret",
    });
  });

  it("preserves provider, explicit Run/system, and runtime override precedence", () => {
    const input = candidateInput({
      modelProviderEnvironment: {
        COLLISION: "provider",
        RUN_OVERRIDE: "provider-run",
      },
      storedConnectorEnvironment: {
        COLLISION: "connector",
        CONNECTOR_ONLY: "connector-only",
      },
      systemAndRunEnvironment: {
        RUN_OVERRIDE: "explicit-run",
        CLI_PKG_URL: "run-cli",
        ZERO_REMOVED: "legacy",
      },
      runtimeOverrides: {
        CLI_PKG_URL: "runtime-cli",
      },
    });
    const before = structuredClone(input);

    expect(buildApplicationOwnedEnvironmentCandidate(input)).toStrictEqual({
      COLLISION: "provider",
      RUN_OVERRIDE: "explicit-run",
      CONNECTOR_ONLY: "connector-only",
      CLI_PKG_URL: "runtime-cli",
    });
    expect(input).toStrictEqual(before);
  });
});

describe("exact environment shadow comparison", () => {
  it.each([
    {
      name: "exact",
      legacy: { SHARED: "same" },
      candidate: { SHARED: "same" },
      expected: {
        classification: "exact",
        legacyOnlyCountBucket: "0",
        candidateOnlyCountBucket: "0",
        sharedValueDifferenceCountBucket: "0",
      },
    },
    {
      name: "legacy-only bindings",
      legacy: { LEGACY: "legacy" },
      candidate: {},
      expected: {
        classification: "legacy_only_bindings",
        legacyOnlyCountBucket: "1",
        candidateOnlyCountBucket: "0",
        sharedValueDifferenceCountBucket: "0",
      },
    },
    {
      name: "candidate-only bindings",
      legacy: {},
      candidate: { CANDIDATE: "candidate" },
      expected: {
        classification: "candidate_only_bindings",
        legacyOnlyCountBucket: "0",
        candidateOnlyCountBucket: "1",
        sharedValueDifferenceCountBucket: "0",
      },
    },
    {
      name: "value override difference",
      legacy: { SHARED: "legacy" },
      candidate: { SHARED: "candidate" },
      expected: {
        classification: "value_override_difference",
        legacyOnlyCountBucket: "0",
        candidateOnlyCountBucket: "0",
        sharedValueDifferenceCountBucket: "1",
      },
    },
    {
      name: "mixed difference",
      legacy: { SHARED: "legacy", LEGACY: "legacy-only" },
      candidate: {
        SHARED: "candidate",
        CANDIDATE: "candidate-only",
      },
      expected: {
        classification: "mixed_difference",
        legacyOnlyCountBucket: "1",
        candidateOnlyCountBucket: "1",
        sharedValueDifferenceCountBucket: "1",
      },
    },
  ] as readonly EnvironmentComparisonCase[])(
    "classifies $name",
    ({ legacy, candidate, expected }) => {
      expect(
        compareApplicationOwnedEnvironment(legacy, candidate),
      ).toStrictEqual(expected);
    },
  );

  it.each([
    [0, "0"],
    [1, "1"],
    [2, "2_4"],
    [4, "2_4"],
    [5, "5_8"],
    [8, "5_8"],
    [9, "9_16"],
    [16, "9_16"],
    [17, "17_plus"],
  ] as const)("buckets %i bindings as %s", (count, expectedBucket) => {
    expect(
      compareApplicationOwnedEnvironment(bindings(count), {}),
    ).toMatchObject({ legacyOnlyCountBucket: expectedBucket });
  });

  it("compares unequal secret values before identical redaction", () => {
    const legacySecret = "legacy-secret-value";
    const candidateSecret = "candidate-secret-value";
    const redact = (
      environment: Readonly<Record<string, string>>,
      secret: string,
    ): Record<string, string> => {
      return Object.fromEntries(
        Object.entries(environment).map(([key, value]) => {
          return [key, value === secret ? "***" : value];
        }),
      );
    };
    const legacy = { TOKEN: legacySecret };
    const candidate = { TOKEN: candidateSecret };

    expect(redact(legacy, legacySecret)).toStrictEqual(
      redact(candidate, candidateSecret),
    );
    expect(compareApplicationOwnedEnvironment(legacy, candidate)).toMatchObject(
      {
        classification: "value_override_difference",
        sharedValueDifferenceCountBucket: "1",
      },
    );
  });

  it("fails with a fixed error when resolved candidate inputs are incomplete", () => {
    expect(() => {
      buildApplicationOwnedEnvironmentCandidate(
        candidateInput({
          modelProviderEnvironment: {
            PRIVATE_PROVIDER_KEY: `\${{ secrets.PRIVATE_PROVIDER_REFERENCE }}`,
          },
        }),
      );
    }).toThrow("Application-owned environment candidate is unavailable");
  });
});
