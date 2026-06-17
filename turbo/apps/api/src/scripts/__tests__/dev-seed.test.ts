import { describe, expect, it } from "vitest";

import { buildUsagePricing, buildVm0ApiKeys } from "../dev-seed";

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

function buildAnthropicKeys(
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildVm0ApiKeys> {
  return buildVm0ApiKeys(readEnvFrom(values), () => {
    // Suppress expected skip logs for vendors that are not configured in tests.
  }).filter((key) => {
    return key.vendor === "anthropic";
  });
}

function buildOpenRouterKeys(
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildVm0ApiKeys> {
  return buildVm0ApiKeys(readEnvFrom(values), () => {
    // Suppress expected skip logs for vendors that are not configured in tests.
  }).filter((key) => {
    return key.vendor === "openrouter";
  });
}

describe("buildVm0ApiKeys", () => {
  it("falls back to ANTHROPIC_API_KEY for Anthropic dev seed rows", () => {
    const anthropicKeys = buildAnthropicKeys({
      DEV_MODEL_ANTHROPIC_KEY: "",
      ANTHROPIC_API_KEY: "provider-anthropic-key",
    });

    expect(anthropicKeys.length).toBeGreaterThan(0);
    expect(anthropicKeys).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "provider-anthropic-key",
          label: "dev-seed",
          model: "claude-sonnet-4-6",
          vendor: "anthropic",
        }),
      ]),
    );
    expect(
      new Set(
        anthropicKeys.map((key) => {
          return key.apiKey;
        }),
      ),
    ).toStrictEqual(new Set(["provider-anthropic-key"]));
  });

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

  it("builds OpenRouter dev seed rows with upstream model ids", () => {
    const openRouterKeys = buildOpenRouterKeys({
      DEV_MODEL_OPENROUTER_KEY: "dev-openrouter-key",
      OPENROUTER_API_KEY: "provider-openrouter-key",
    });

    expect(openRouterKeys.length).toBeGreaterThan(0);
    expect(openRouterKeys).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "dev-openrouter-key",
          label: "dev-seed",
          model: "z-ai/glm-5.2",
          vendor: "openrouter",
        }),
        expect.objectContaining({
          apiKey: "dev-openrouter-key",
          label: "dev-seed",
          model: "z-ai/glm-5.1",
          vendor: "openrouter",
        }),
      ]),
    );
    expect(
      new Set(
        openRouterKeys.map((key) => {
          return key.apiKey;
        }),
      ),
    ).toStrictEqual(new Set(["dev-openrouter-key"]));
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

describe("buildUsagePricing", () => {
  it("builds GLM 5.2 model usage pricing rows", () => {
    const glm52Pricing = buildUsagePricing().filter((row) => {
      return row.kind === "model" && row.provider === "glm-5.2";
    });

    expect(glm52Pricing).toStrictEqual([
      {
        kind: "model",
        provider: "glm-5.2",
        category: "tokens.input",
        unitPrice: 1400,
        unitSize: 1_000_000,
      },
      {
        kind: "model",
        provider: "glm-5.2",
        category: "tokens.output",
        unitPrice: 4400,
        unitSize: 1_000_000,
      },
      {
        kind: "model",
        provider: "glm-5.2",
        category: "tokens.cache_read",
        unitPrice: 260,
        unitSize: 1_000_000,
      },
    ]);
    expect(
      glm52Pricing.some((row) => {
        return row.category === "tokens.cache_creation";
      }),
    ).toBeFalsy();
  });
});
