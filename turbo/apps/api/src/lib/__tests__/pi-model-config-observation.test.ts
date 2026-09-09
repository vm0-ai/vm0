import { describe, expect, it } from "vitest";

import { piModelConfigObservation } from "../pi-model-config-observation";

// This secret-safe projection accepts historical/future captured shapes that
// current production admission cannot construct. Route tests cover new writes;
// this finite boundary matrix proves arbitrary input never becomes telemetry.
describe("Pi captured-config observation boundary", () => {
  it.each([
    [{}, "absent"],
    [{ api: "openai-responses" }, "public-responses"],
    [{ api: "openai-completions" }, "historical-completions"],
    [{ api: "openai-codex-responses" }, "historical-codex"],
    [{ api: "private-unrecognized-value" }, "unknown"],
    [{ api: null }, "unknown"],
  ] as const)("classifies captured Gen1 %j as %s", (legacy, state) => {
    expect(
      piModelConfigObservation("pi", {
        ...legacy,
        apiKey: "private-key",
        accountId: "private-account",
        baseUrl: "https://private-gateway.test",
        headers: { Authorization: "private-token" },
        prompt: "private-prompt",
      }),
    ).toStrictEqual({
      piModelConfigGeneration: 1,
      piModelConfigLegacyApi: state,
    });
  });

  it.each([2, 3, 4] as const)(
    "distinguishes active generation %s dialects from legacy api",
    (schemaVersion) => {
      for (const dialect of [
        "openai-responses",
        "openai-codex-responses",
        "anthropic-messages",
        "bedrock-converse-stream",
      ]) {
        expect(
          piModelConfigObservation("pi", {
            schemaVersion,
            dialect,
            credentialBindings: [{ secretName: "private-secret-name" }],
          }),
        ).toStrictEqual({
          piModelConfigGeneration: schemaVersion,
          piModelConfigLegacyApi: "absent",
        });
      }
    },
  );

  it.each([undefined, null, [], "private-config"])(
    "reports an unavailable captured config as unknown: %j",
    (config) => {
      expect(piModelConfigObservation("pi", config)).toStrictEqual({
        piModelConfigGeneration: "unknown",
        piModelConfigLegacyApi: "unknown",
      });
    },
  );

  it("preserves unknown generations and unexpected versioned legacy fields", () => {
    expect(
      piModelConfigObservation("pi", {
        schemaVersion: 5,
        api: "openai-responses",
      }),
    ).toStrictEqual({
      piModelConfigGeneration: "unknown",
      piModelConfigLegacyApi: "public-responses",
    });
    expect(
      piModelConfigObservation("pi", {
        schemaVersion: 3,
        api: "private-value",
      }),
    ).toStrictEqual({
      piModelConfigGeneration: 3,
      piModelConfigLegacyApi: "unknown",
    });
  });

  it.each([undefined, "codex", "claude-code"])(
    "leaves non-Pi snapshots unclassified: %s",
    (cliAgentType) => {
      expect(piModelConfigObservation(cliAgentType, {})).toBeUndefined();
    },
  );
});
