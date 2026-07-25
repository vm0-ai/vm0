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

function buildZaiKeys(
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildVm0ApiKeys> {
  return buildVm0ApiKeys(readEnvFrom(values), () => {
    // Suppress expected skip logs for vendors that are not configured in tests.
  }).filter((key) => {
    return key.vendor === "zai";
  });
}

function buildOpenAiKeys(
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildVm0ApiKeys> {
  return buildVm0ApiKeys(readEnvFrom(values), () => {
    // Suppress expected skip logs for vendors that are not configured in tests.
  }).filter((key) => {
    return key.vendor === "openai";
  });
}

function buildMoonshotKeys(
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildVm0ApiKeys> {
  return buildVm0ApiKeys(readEnvFrom(values), () => {
    // Suppress expected skip logs for vendors that are not configured in tests.
  }).filter((key) => {
    return key.vendor === "moonshot";
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
          model: "claude-fable-5",
          vendor: "anthropic",
        }),
        expect.objectContaining({
          apiKey: "provider-anthropic-key",
          label: "dev-seed",
          model: "claude-opus-5",
          vendor: "anthropic",
        }),
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
          model: "xiaomi/mimo-v2.5",
          vendor: "openrouter",
        }),
        expect.objectContaining({
          apiKey: "dev-openrouter-key",
          label: "dev-seed",
          model: "tencent/hy3-preview",
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

  it("builds Z.AI dev seed rows with native GLM model ids", () => {
    const zaiKeys = buildZaiKeys({
      DEV_MODEL_ZAI_KEY: "dev-zai-key",
    });

    expect(zaiKeys.length).toBeGreaterThan(0);
    expect(zaiKeys).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "dev-zai-key",
          label: "dev-seed",
          model: "glm-5.2",
          vendor: "zai",
        }),
        expect.objectContaining({
          apiKey: "dev-zai-key",
          label: "dev-seed",
          model: "glm-5.1",
          vendor: "zai",
        }),
      ]),
    );
    expect(
      new Set(
        zaiKeys.map((key) => {
          return key.apiKey;
        }),
      ),
    ).toStrictEqual(new Set(["dev-zai-key"]));
  });

  it("builds OpenAI dev seed rows for GPT 5.6 models", () => {
    const openAiKeys = buildOpenAiKeys({
      DEV_MODEL_OPENAI_KEY: "dev-openai-key",
      OPENAI_API_KEY: "provider-openai-key",
    });

    expect(openAiKeys).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "dev-openai-key",
          label: "dev-seed",
          model: "gpt-5.6-sol",
          vendor: "openai",
        }),
        expect.objectContaining({
          apiKey: "dev-openai-key",
          label: "dev-seed",
          model: "gpt-5.6-terra",
          vendor: "openai",
        }),
        expect.objectContaining({
          apiKey: "dev-openai-key",
          label: "dev-seed",
          model: "gpt-5.6-luna",
          vendor: "openai",
        }),
      ]),
    );
    expect(
      new Set(
        openAiKeys.map((key) => {
          return key.apiKey;
        }),
      ),
    ).toStrictEqual(new Set(["dev-openai-key"]));
  });

  it("falls back to MOONSHOT_API_KEY for the Kimi K3 dev seed row", () => {
    const moonshotKeys = buildMoonshotKeys({
      DEV_MODEL_MOONSHOT_KEY: "",
      MOONSHOT_API_KEY: "provider-moonshot-key",
    });

    expect(moonshotKeys).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiKey: "provider-moonshot-key",
          label: "dev-seed",
          model: "kimi-k3",
          vendor: "moonshot",
        }),
      ]),
    );
    expect(
      new Set(
        moonshotKeys.map((key) => {
          return key.apiKey;
        }),
      ),
    ).toStrictEqual(new Set(["provider-moonshot-key"]));
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
