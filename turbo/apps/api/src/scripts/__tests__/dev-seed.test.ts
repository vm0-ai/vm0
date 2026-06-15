import { describe, expect, it } from "vitest";

import { buildVm0ApiKeys } from "../dev-seed";

function readEnvFrom(
  values: Readonly<Record<string, string | undefined>>,
): (name: string) => string | undefined {
  return (name) => {
    return values[name];
  };
}

function buildDeepSeekKeys(
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildVm0ApiKeys> {
  return buildVm0ApiKeys(readEnvFrom(values), () => {
    // Suppress expected skip logs for vendors that are not configured in tests.
  }).filter((key) => {
    return key.vendor === "deepseek";
  });
}

describe("buildVm0ApiKeys", () => {
  it("builds DeepSeek dev seed rows from DEV_MODEL_DEEPSEEK_KEY", () => {
    const deepSeekKeys = buildDeepSeekKeys({
      DEV_MODEL_DEEPSEEK_KEY: "dev-deepseek-key",
      DEEPSEEK_API_KEY: "provider-deepseek-key",
    });

    expect(deepSeekKeys.length).toBeGreaterThan(0);
    expect(deepSeekKeys).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "dev-deepseek-key",
          label: "dev-seed",
          model: "deepseek-v4-pro",
          vendor: "deepseek",
        }),
      ]),
    );
    expect(
      new Set(
        deepSeekKeys.map((key) => {
          return key.apiKey;
        }),
      ),
    ).toStrictEqual(new Set(["dev-deepseek-key"]));
  });

  it("falls back to DEEPSEEK_API_KEY for DeepSeek dev seed rows", () => {
    const deepSeekKeys = buildDeepSeekKeys({
      DEV_MODEL_DEEPSEEK_KEY: "",
      DEEPSEEK_API_KEY: "provider-deepseek-key",
    });

    expect(deepSeekKeys.length).toBeGreaterThan(0);
    expect(deepSeekKeys).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "provider-deepseek-key",
          label: "dev-seed",
          model: "deepseek-v4-pro",
          vendor: "deepseek",
        }),
      ]),
    );
    expect(
      new Set(
        deepSeekKeys.map((key) => {
          return key.apiKey;
        }),
      ),
    ).toStrictEqual(new Set(["provider-deepseek-key"]));
  });
});
