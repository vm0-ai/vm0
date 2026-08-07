import { describe, expect, it } from "vitest";

import { buildVm0ApiKeys } from "../dev-seed";

function readEnvFrom(
  values: Readonly<Record<string, string | undefined>>,
): (name: string) => string | undefined {
  return (name) => {
    return values[name];
  };
}

function buildVendorKeys(
  vendor: string,
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildVm0ApiKeys> {
  return buildVm0ApiKeys(readEnvFrom(values), () => {
    // Suppress expected skip logs for vendors that are not configured in tests.
  }).filter((key) => {
    return key.vendor === vendor;
  });
}

describe("buildVm0ApiKeys", () => {
  it("falls back to ANTHROPIC_API_KEY for Anthropic dev seed rows", () => {
    const anthropicKeys = buildVendorKeys("anthropic", {
      DEV_MODEL_ANTHROPIC_KEY: "",
      ANTHROPIC_API_KEY: "provider-anthropic-key",
    });

    expect(anthropicKeys).toStrictEqual([
      {
        apiKey: "provider-anthropic-key",
        label: "dev-seed",
        vendor: "anthropic",
      },
    ]);
  });

  it("builds DeepSeek dev seed rows from DEV_MODEL_DEEPSEEK_KEY", () => {
    const deepSeekKeys = buildVendorKeys("deepseek", {
      DEV_MODEL_DEEPSEEK_KEY: "dev-deepseek-key",
      DEEPSEEK_API_KEY: "provider-deepseek-key",
    });

    expect(deepSeekKeys).toStrictEqual([
      {
        apiKey: "dev-deepseek-key",
        label: "dev-seed",
        vendor: "deepseek",
      },
    ]);
  });

  it("builds one OpenRouter dev seed row", () => {
    const openRouterKeys = buildVendorKeys("openrouter", {
      DEV_MODEL_OPENROUTER_KEY: "dev-openrouter-key",
      OPENROUTER_API_KEY: "provider-openrouter-key",
    });

    expect(openRouterKeys).toStrictEqual([
      {
        apiKey: "dev-openrouter-key",
        label: "dev-seed",
        vendor: "openrouter",
      },
    ]);
  });

  it("builds one Z.AI dev seed row", () => {
    const zaiKeys = buildVendorKeys("zai", {
      DEV_MODEL_ZAI_KEY: "dev-zai-key",
    });

    expect(zaiKeys).toStrictEqual([
      {
        apiKey: "dev-zai-key",
        label: "dev-seed",
        vendor: "zai",
      },
    ]);
  });

  it("builds one OpenAI dev seed row", () => {
    const openAiKeys = buildVendorKeys("openai", {
      DEV_MODEL_OPENAI_KEY: "dev-openai-key",
      OPENAI_API_KEY: "provider-openai-key",
    });

    expect(openAiKeys).toStrictEqual([
      {
        apiKey: "dev-openai-key",
        label: "dev-seed",
        vendor: "openai",
      },
    ]);
  });

  it("falls back to MOONSHOT_API_KEY for the Moonshot dev seed row", () => {
    const moonshotKeys = buildVendorKeys("moonshot", {
      DEV_MODEL_MOONSHOT_KEY: "",
      MOONSHOT_API_KEY: "provider-moonshot-key",
    });

    expect(moonshotKeys).toStrictEqual([
      {
        apiKey: "provider-moonshot-key",
        label: "dev-seed",
        vendor: "moonshot",
      },
    ]);
  });

  it("falls back to DEEPSEEK_API_KEY for DeepSeek dev seed rows", () => {
    const deepSeekKeys = buildVendorKeys("deepseek", {
      DEV_MODEL_DEEPSEEK_KEY: "",
      DEEPSEEK_API_KEY: "provider-deepseek-key",
    });

    expect(deepSeekKeys).toStrictEqual([
      {
        apiKey: "provider-deepseek-key",
        label: "dev-seed",
        vendor: "deepseek",
      },
    ]);
  });
});
